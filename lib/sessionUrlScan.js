// Scan an active Claude/Cursor session's JSONL for the most recent
// localhost URL it announced — the same one shown in the user's
// Cursor terminal or Claude Code output ("Local: http://localhost:5173/").
//
// We don't try to be clever about JSON shape: dev-server URLs land in
// many places (assistant text, Bash tool_result stdout, tool_use args).
// Brute-force regex against the raw line catches all of them, and a
// quick HTTP probe filters out URLs from dead servers (yesterday's run,
// crashed restart, etc.).

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const claudeReader = require("./claudeReader");
const cursorReader = require("./cursor");

// Ports we never want to surface as a "dev server" (system/well-known
// services that happen to bind localhost). Real dev servers live above
// 1024 and outside this list.
const PORT_DENY = new Set([
  1080, 3306, 5432, 6379, 8443, 11434, 27017, 50000, 50051,
]);

// Veronum's own port — previewing ourselves causes a hall-of-mirrors.
const SELF_PORT = parseInt(process.env.PORT || "3001", 10);
if (Number.isInteger(SELF_PORT)) PORT_DENY.add(SELF_PORT);

const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})\b/g;

function extractCandidates(text) {
  const out = [];
  for (const m of String(text).matchAll(URL_RE)) {
    const port = parseInt(m[1], 10);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) continue;
    if (PORT_DENY.has(port)) continue;
    out.push({ port, url: `http://localhost:${port}/` });
  }
  return out;
}

async function checkAlive(url) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 1500);
    const r = await fetch(url, { signal: c.signal, redirect: "manual" });
    clearTimeout(t);
    return r.status < 600;
  } catch { return false; }
}

// Read the tail of the JSONL (default 2MB — enough to cover the recent
// few turns even for chatty Bash output) and walk it in reverse so the
// newest URL wins. First port that probes alive is returned.
async function scanFileForLiveUrl(filePath, { tailBytes = 2 * 1024 * 1024 } = {}) {
  let text;
  try {
    const st = await fs.promises.stat(filePath);
    if (st.size <= tailBytes) {
      text = await fs.promises.readFile(filePath, "utf8");
    } else {
      const fh = await fs.promises.open(filePath, "r");
      try {
        const buf = Buffer.alloc(tailBytes);
        await fh.read(buf, 0, tailBytes, st.size - tailBytes);
        const startNl = buf.indexOf(0x0a);
        text = buf.slice(startNl + 1).toString("utf8");
      } finally { await fh.close(); }
    }
  } catch { return null; }

  const lines = text.split("\n");
  const tried = new Set();
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    for (const cand of extractCandidates(line)) {
      if (tried.has(cand.port)) continue;
      tried.add(cand.port);
      if (await checkAlive(cand.url)) return cand;
    }
  }
  return null;
}

async function scanClaudeSession({ cwd, sessionId }) {
  if (!cwd || !sessionId) return null;
  const found = await claudeReader.findSessionJsonl(sessionId, cwd);
  if (!found) return null;
  return scanFileForLiveUrl(found.path);
}

// ─── Project-cwd inference ───────────────────────────────────────────
// When the session's literal cwd has no project (e.g. the user opened
// Claude in ~ and then `cd electron-landing`'d into a real project),
// scan the JSONL for absolute paths the session has actually touched
// and return the most-recent path that looks like a project root —
// i.e. has package.json or index.html.

function nearestProjectRoot(candidatePath) {
  // Walk up at most 6 levels; the candidate is usually a file or dir
  // inside a project, not the project root itself.
  let dir = candidatePath;
  // If it's a file, start at its parent.
  try {
    const st = fs.statSync(dir);
    if (st.isFile()) dir = path.dirname(dir);
  } catch { /* path may not exist on disk anymore — skip */ }
  for (let i = 0; i < 6; i++) {
    try {
      if (fs.existsSync(path.join(dir, "package.json")) ||
          fs.existsSync(path.join(dir, "index.html"))) {
        return dir;
      }
    } catch { /* ignore */ }
    const parent = path.dirname(dir);
    if (!parent || parent === dir || parent === "/") break;
    dir = parent;
  }
  return null;
}

// Pull absolute path candidates out of a chunk of session text. We're
// conservative: only paths under the user's home dir count (so we don't
// match random /tmp, /etc strings) and we skip paths that obviously
// aren't projects (.git/, node_modules/, etc).
const PATH_DENY = /\/(?:node_modules|\.git|\.next|\.turbo|\.cache|dist|build|\.DS_Store)(?:\/|$)/;
function extractPathCandidates(text, homeDir) {
  const out = [];
  // 1. `cd /path` in Bash commands. Both bare and quoted forms.
  const cdRe = /(?:^|;|&&|\|\|)\s*cd\s+["']?(\/[^"';\s|&]+)/g;
  for (const m of String(text).matchAll(cdRe)) out.push(m[1]);
  // 2. Any absolute path under the user's home dir mentioned in JSON.
  //    The JSONL has these in Bash args, file_path args, tool_result text.
  //    Escape regex specials in homeDir to be safe with spaces etc.
  const homeEsc = homeDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const homeRe = new RegExp(`${homeEsc}/[A-Za-z0-9_\\-./ ]+`, "g");
  for (const m of String(text).matchAll(homeRe)) {
    // Trim trailing punctuation that's likely not part of the path.
    let p = m[0].replace(/[.,;:'")\]}]+$/, "");
    if (!PATH_DENY.test(p)) out.push(p);
  }
  return out;
}

async function scanFileForProjectCwd(filePath, originalCwd, { tailBytes = 2 * 1024 * 1024 } = {}) {
  let text;
  try {
    const st = await fs.promises.stat(filePath);
    if (st.size <= tailBytes) {
      text = await fs.promises.readFile(filePath, "utf8");
    } else {
      const fh = await fs.promises.open(filePath, "r");
      try {
        const buf = Buffer.alloc(tailBytes);
        await fh.read(buf, 0, tailBytes, st.size - tailBytes);
        const startNl = buf.indexOf(0x0a);
        text = buf.slice(startNl + 1).toString("utf8");
      } finally { await fh.close(); }
    }
  } catch { return null; }

  const home = os.homedir();
  const lines = text.split("\n");
  const tried = new Set();
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    for (const candidate of extractPathCandidates(line, home)) {
      if (tried.has(candidate)) continue;
      tried.add(candidate);
      const root = nearestProjectRoot(candidate);
      if (root && root !== originalCwd) return root;
    }
  }
  return null;
}

async function scanClaudeSessionForProject({ cwd, sessionId }) {
  if (!sessionId) return null;
  const found = await claudeReader.findSessionJsonl(sessionId, cwd);
  if (!found) return null;
  return scanFileForProjectCwd(found.path, cwd);
}

async function scanCursorSessionForProject({ cwd, sessionId }) {
  if (!sessionId) return null;
  const dashed = cursorReader.dashedCwd(cwd);
  if (!dashed) return null;
  const fp = path.join(
    os.homedir(), ".cursor", "projects", dashed,
    "agent-transcripts", sessionId, `${sessionId}.jsonl`,
  );
  if (!fs.existsSync(fp)) return null;
  return scanFileForProjectCwd(fp, cwd);
}

// Single entry point for callers: resolves the best project cwd from
// the session, or returns null if nothing useful was found.
async function resolveProjectCwd({ source, cwd, sessionId }) {
  if (!source || !sessionId) return null;
  if (source === "claude") return scanClaudeSessionForProject({ cwd, sessionId });
  if (source === "cursor") return scanCursorSessionForProject({ cwd, sessionId });
  return null;
}

async function scanCursorSession({ cwd, sessionId }) {
  if (!cwd || !sessionId) return null;
  const dashed = cursorReader.dashedCwd(cwd);
  if (!dashed) return null;
  const fp = path.join(
    os.homedir(), ".cursor", "projects", dashed,
    "agent-transcripts", sessionId, `${sessionId}.jsonl`,
  );
  if (!fs.existsSync(fp)) return null;
  return scanFileForLiveUrl(fp);
}

function mountSessionUrl(app) {
  app.get("/api/preview/session-url", async (req, res) => {
    try {
      const source = String(req.query.source || "").toLowerCase();
      const cwd = req.query.cwd ? String(req.query.cwd) : "";
      const id = req.query.id ? String(req.query.id) : "";
      if (!cwd || !id) return res.json({ ok: true, url: null });
      let found = null;
      if (source === "claude") found = await scanClaudeSession({ cwd, sessionId: id });
      else if (source === "cursor") found = await scanCursorSession({ cwd, sessionId: id });
      else return res.json({ ok: true, url: null });
      if (!found) return res.json({ ok: true, url: null });
      res.json({ ok: true, url: found.url, port: found.port, source });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
}

module.exports = { mountSessionUrl, scanClaudeSession, scanCursorSession, resolveProjectCwd };
