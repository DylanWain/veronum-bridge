/**
 * lib/git.js — Save / list / revert versions for a project, backed
 * by real git commits.
 *
 * Endpoints (all take cwd in query/body):
 *   GET  /api/git/log               → recent versions (commits)
 *   POST /api/git/save  {message}   → commits the working tree
 *   POST /api/git/revert {hash, name?} → checkout that tree + commit
 *                                        (revert preserves history so
 *                                        the user can undo the undo)
 *
 * Behavior notes:
 *   - If the project isn't a git repo yet, the first save auto-runs
 *     `git init` + a baseline `.gitignore` (node_modules, .DS_Store).
 *   - Sets a Veronum identity if the repo has no user.name/email so
 *     `git commit` doesn't fail on fresh installs.
 *   - "Revert to X" works by checking out X's tree into the working
 *     dir, then committing — preserves all later commits in history.
 */

"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

// Run a git subcommand in cwd. Returns { code, stdout, stderr }.
function git(cwd, args, { input = null } = {}) {
  return new Promise((resolve) => {
    const proc = spawn("git", args, {
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString("utf8"); });
    proc.stderr.on("data", (d) => { stderr += d.toString("utf8"); });
    proc.on("close", (code) => resolve({ code, stdout, stderr }));
    proc.on("error", (e) => resolve({ code: -1, stdout, stderr: stderr + e.message }));
    if (input != null) {
      try { proc.stdin.write(input); proc.stdin.end(); }
      catch { /* ignore */ }
    }
  });
}

async function isGitRepo(cwd) {
  const r = await git(cwd, ["rev-parse", "--git-dir"]);
  return r.code === 0;
}

async function ensureInit(cwd) {
  if (await isGitRepo(cwd)) return false;
  await git(cwd, ["init"]);
  // Sensible default ignore so the first commit isn't 500MB of node_modules.
  const gi = path.join(cwd, ".gitignore");
  try {
    await fsp.access(gi);
  } catch {
    await fsp.writeFile(gi,
      "node_modules/\n.DS_Store\n.env\n.env.*\n!.env.example\ndist/\n.next/\n.turbo/\n.cache/\n*.log\n.veronum/edits.json\n",
      "utf8",
    );
  }
  return true; // freshly initialized
}

async function ensureIdentity(cwd) {
  const a = await git(cwd, ["config", "user.name"]);
  if (a.code !== 0 || !a.stdout.trim()) {
    await git(cwd, ["config", "user.name", "Veronum"]);
  }
  const b = await git(cwd, ["config", "user.email"]);
  if (b.code !== 0 || !b.stdout.trim()) {
    await git(cwd, ["config", "user.email", "noreply@veronum.local"]);
  }
}

// Returns { hasRemote, remoteUrl, branch } so callers can decide
// whether a push is even possible before attempting it.
async function remoteInfo(cwd) {
  if (!(await isGitRepo(cwd))) return { hasRemote: false, remoteUrl: null, branch: null };
  const r = await git(cwd, ["remote", "get-url", "origin"]);
  const hasRemote = r.code === 0 && !!r.stdout.trim();
  const remoteUrl = hasRemote ? r.stdout.trim() : null;
  const b = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = b.code === 0 ? b.stdout.trim() : null;
  return { hasRemote, remoteUrl, branch };
}

// Push HEAD to origin/<current-branch>. First push on a fresh branch
// uses -u so the upstream is set; subsequent pushes are a plain push.
// Returns { ok, pushed, remoteUrl, branch, message } — never throws,
// so callers can include a push result inline with a successful save.
async function pushToRemote(cwd) {
  const info = await remoteInfo(cwd);
  if (!info.hasRemote) {
    return { ok: true, pushed: false, message: "no remote configured" };
  }
  if (!info.branch || info.branch === "HEAD") {
    return { ok: false, pushed: false, message: "detached HEAD — can't push" };
  }
  // Check if upstream is set so we know whether to add -u.
  const up = await git(cwd, ["rev-parse", "--abbrev-ref", `${info.branch}@{upstream}`]);
  const hasUpstream = up.code === 0;
  const args = ["push"];
  if (!hasUpstream) args.push("-u", "origin", info.branch);
  const r = await git(cwd, args);
  if (r.code !== 0) {
    return {
      ok: false,
      pushed: false,
      remoteUrl: info.remoteUrl,
      branch: info.branch,
      message: (r.stderr || r.stdout).trim().slice(0, 600),
    };
  }
  return {
    ok: true,
    pushed: true,
    remoteUrl: info.remoteUrl,
    branch: info.branch,
    message: `pushed to ${info.branch}`,
  };
}

// Detect whether `gh` is installed AND authenticated, so the UI can
// show / hide the "Create GitHub repo" button accordingly.
async function ghAvailable() {
  return new Promise((resolve) => {
    const proc = spawn("gh", ["auth", "status"], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d.toString("utf8"); });
    proc.on("close", (code) => {
      // gh prints status to stderr (yes really). Exit 0 = logged in.
      resolve({ installed: true, authed: code === 0 });
    });
    proc.on("error", () => resolve({ installed: false, authed: false }));
  });
}

// One-shot: init repo if needed → create GitHub repo via gh →
// set as origin → push. `visibility` is "private" or "public".
async function createGithubRepo(cwd, { name, visibility = "private" } = {}) {
  if (!cwd) throw new Error("cwd required");
  if (!name) throw new Error("name required");
  await ensureInit(cwd);
  await ensureIdentity(cwd);
  // Has to have at least one commit before push, otherwise gh creates
  // an empty repo and the user wonders why nothing is there.
  const head = await git(cwd, ["rev-parse", "HEAD"]);
  if (head.code !== 0) {
    await git(cwd, ["add", "-A"]);
    await git(cwd, ["commit", "-m", "initial commit"]);
  }
  const visFlag = visibility === "public" ? "--public" : "--private";
  const proc = spawn("gh", ["repo", "create", name, "--source=.", visFlag, "--push"], {
    cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  let stdout = "", stderr = "";
  proc.stdout.on("data", (d) => { stdout += d.toString("utf8"); });
  proc.stderr.on("data", (d) => { stderr += d.toString("utf8"); });
  return new Promise((resolve, reject) => {
    proc.on("close", async (code) => {
      if (code !== 0) {
        return reject(new Error((stderr || stdout).trim() || `gh repo create exited ${code}`));
      }
      const info = await remoteInfo(cwd);
      resolve({ ok: true, remoteUrl: info.remoteUrl, branch: info.branch });
    });
    proc.on("error", (err) => reject(err));
  });
}

// Recent commits, newest first. Limit kept tight so the UI list is fast.
async function listVersions(cwd, limit = 50) {
  if (!(await isGitRepo(cwd))) return [];
  const FMT = "%H%x09%at%x09%an%x09%s"; // hash \t unix-ts \t author \t subject
  const r = await git(cwd, ["log", `--max-count=${limit}`, `--format=${FMT}`]);
  if (r.code !== 0) return [];
  const out = [];
  for (const line of r.stdout.split("\n")) {
    if (!line) continue;
    const [hash, ts, author, ...rest] = line.split("\t");
    if (!hash) continue;
    out.push({
      hash,
      shortHash: hash.slice(0, 7),
      ts: parseInt(ts, 10) * 1000,
      author,
      message: rest.join("\t"),
    });
  }
  return out;
}

async function saveVersion(cwd, message) {
  if (!cwd) throw new Error("cwd required");
  const msg = String(message || "").trim();
  if (!msg) throw new Error("message required");
  await ensureInit(cwd);
  await ensureIdentity(cwd);
  // Stage everything, including new + deleted files.
  const add = await git(cwd, ["add", "-A"]);
  if (add.code !== 0) throw new Error("git add failed: " + add.stderr.trim());
  // Commit. If nothing changed, return a friendly "no_changes" signal.
  const c = await git(cwd, ["commit", "-m", msg]);
  if (c.code !== 0) {
    if (/nothing to commit|no changes added/i.test(c.stdout + c.stderr)) {
      return { ok: true, noChanges: true, push: { pushed: false, message: "no changes" } };
    }
    throw new Error("git commit failed: " + (c.stderr || c.stdout).trim());
  }
  const head = await git(cwd, ["rev-parse", "HEAD"]);
  // Auto-push if there's a remote. Push result is always returned
  // (success OR failure) so the UI can surface it; we never throw
  // from the save endpoint just because push failed.
  const push = await pushToRemote(cwd);
  return { ok: true, noChanges: false, hash: head.stdout.trim(), push };
}

// "Revert to X" — make the working tree match X, then commit. This
// preserves all later commits in history (unlike `git reset --hard`),
// so the user can undo the revert just like any other version.
async function revertToVersion(cwd, hash, name) {
  if (!cwd) throw new Error("cwd required");
  if (!hash || typeof hash !== "string") throw new Error("hash required");
  if (!(await isGitRepo(cwd))) throw new Error("not a git repo");
  await ensureIdentity(cwd);
  // Verify hash exists in this repo before we touch anything.
  const v = await git(cwd, ["cat-file", "-t", hash]);
  if (v.code !== 0 || v.stdout.trim() !== "commit") {
    throw new Error("unknown version");
  }
  // Pull that commit's tree into the working dir AND the index. The
  // `-- :/` pathspec means "everything from the repo root", regardless
  // of where we are inside the project.
  const co = await git(cwd, ["checkout", hash, "--", ":/"]);
  if (co.code !== 0) {
    throw new Error("checkout failed: " + (co.stderr || co.stdout).trim());
  }
  // Files that EXIST at HEAD but NOT in target need to be deleted —
  // checkout won't remove them. `git clean -fd` would, but that also
  // nukes untracked files the user might want to keep. Safer:
  // diff target against the now-checked-out tree to find extras and
  // delete only those.
  const extra = await git(cwd, ["diff", "--name-only", "--diff-filter=D", hash, "HEAD"]);
  if (extra.code === 0) {
    for (const rel of extra.stdout.split("\n")) {
      if (!rel) continue;
      try { await fsp.unlink(path.join(cwd, rel)); } catch {}
    }
  }
  // Stage + commit the revert as its own version.
  await git(cwd, ["add", "-A"]);
  const label = String(name || "").trim() || `Revert to ${hash.slice(0, 7)}`;
  const c = await git(cwd, ["commit", "-m", label, "--allow-empty"]);
  if (c.code !== 0) {
    throw new Error("commit failed: " + (c.stderr || c.stdout).trim());
  }
  const head = await git(cwd, ["rev-parse", "HEAD"]);
  const push = await pushToRemote(cwd);
  return { ok: true, hash: head.stdout.trim(), push };
}

function mountGit(app) {
  app.get("/api/git/log", async (req, res) => {
    const cwd = String(req.query.cwd || "");
    if (!cwd) return res.status(400).json({ ok: false, error: "cwd required" });
    if (!fs.existsSync(cwd)) return res.status(404).json({ ok: false, error: "cwd not found" });
    try {
      const [versions, initialized, info, gh] = await Promise.all([
        listVersions(cwd),
        isGitRepo(cwd),
        remoteInfo(cwd),
        ghAvailable(),
      ]);
      res.json({
        ok: true,
        initialized,
        versions,
        remote: info,           // { hasRemote, remoteUrl, branch }
        ghAvailable: gh.authed, // can offer "Create GitHub repo"
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post("/api/git/create-github-repo", async (req, res) => {
    const { cwd, name, visibility } = req.body || {};
    if (!cwd || !name) return res.status(400).json({ ok: false, error: "cwd + name required" });
    if (!fs.existsSync(cwd)) return res.status(404).json({ ok: false, error: "cwd not found" });
    try {
      const r = await createGithubRepo(cwd, { name, visibility });
      res.json(r);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post("/api/git/save", async (req, res) => {
    const { cwd, message } = req.body || {};
    if (!cwd || !message) return res.status(400).json({ ok: false, error: "cwd + message required" });
    if (!fs.existsSync(cwd)) return res.status(404).json({ ok: false, error: "cwd not found" });
    try {
      const r = await saveVersion(cwd, message);
      res.json(r);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post("/api/git/revert", async (req, res) => {
    const { cwd, hash, name } = req.body || {};
    if (!cwd || !hash) return res.status(400).json({ ok: false, error: "cwd + hash required" });
    if (!fs.existsSync(cwd)) return res.status(404).json({ ok: false, error: "cwd not found" });
    try {
      const r = await revertToVersion(cwd, hash, name);
      res.json(r);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
}

module.exports = { mountGit, listVersions, saveVersion, revertToVersion };
