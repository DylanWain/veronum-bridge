// Claude session reader — ported from veronum-overlay/main.js
// (findSessionJsonl, parseClaudeJsonl, encodeProjectPath). Single
// responsibility: locate the JSONL on disk for a given cwd+sid and
// parse its lines into { role, text } messages.
//
// Same mechanism as the Veronum overlay DMG, just stripped down to
// the local-fs path (no Supabase mirror, no invite-link share, no
// metadata sidecar fallback). The user explicitly wants this to be
// a clean port of the chat-loading bit, nothing else.

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

// Claude encodes the cwd as a directory name by replacing `/` and
// spaces with `-`. E.g. `/Users/dylanwain/T3 Tools` becomes
// `-Users-dylanwain-T3-Tools`. The encoding is lossy (we can't perfectly
// recover the cwd from the dir name when there are spaces), so we
// always work cwd → dirName, never dirName → cwd.
function encodeProjectPath(cwd) {
  return cwd.replace(/[/ ]/g, "-");
}

// Find the JSONL for sessionId. Claude sometimes writes it under
// slightly different encodings of the cwd (e.g. legacy hyphen vs
// space handling), so we try a few candidates.
async function findSessionJsonl(sessionId, cwd) {
  const candidates = [
    encodeProjectPath(cwd),                              // standard
    "-" + cwd.replace(/\//g, "-"),                       // older style
  ];
  for (const dirName of candidates) {
    const fp = path.join(CLAUDE_PROJECTS_DIR, dirName, sessionId + ".jsonl");
    try {
      const st = await fs.promises.stat(fp);
      if (st.isFile()) return { path: fp, size: st.size, mtimeMs: st.mtimeMs };
    } catch { /* try next */ }
  }
  return null;
}

// Stream-parse the JSONL into a flat list of { role, text, ts } messages.
// Skips: tool-use blocks (the AI's internal scratch), system reminders,
// queue-operation events, hook output. Keeps: user prompts and final
// assistant prose. Mirrors what overlays show in their chat panes.
async function parseClaudeJsonl(fp) {
  const text = await fs.promises.readFile(fp, "utf8");
  const out = [];
  const seenUuids = new Set();
  let title = "";
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    // De-dup by uuid (some events get written twice on retries)
    if (obj.uuid && seenUuids.has(obj.uuid)) continue;
    if (obj.uuid) seenUuids.add(obj.uuid);

    const ts = obj.timestamp ? new Date(obj.timestamp).getTime() : 0;

    // Summary lines from Claude Desktop's auto-titling pass — use as title
    if (obj.type === "summary" && typeof obj.summary === "string" && obj.summary.trim() && !title) {
      title = obj.summary.trim().slice(0, 200);
      continue;
    }

    if (obj.type === "user" && obj.message) {
      const t = extractText(obj.message.content);
      if (t && !isSystemReminder(t)) out.push({ role: "user", text: t, ts, uuid: obj.uuid });
    } else if (obj.type === "assistant" && obj.message) {
      const t = extractText(obj.message.content);
      if (t) out.push({ role: "assistant", text: t, ts, uuid: obj.uuid });
    }
  }
  // Pick a title if we don't have a summary: use the first user message
  if (!title) {
    const firstUser = out.find((m) => m.role === "user");
    if (firstUser) title = firstUser.text.slice(0, 80);
  }
  return { title, messages: out };
}

function extractText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p) => p && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n")
    .trim();
}

// Heuristic: messages that are pure system-reminder injections shouldn't
// appear in the user-visible chat. They start with the literal tag.
function isSystemReminder(text) {
  if (!text) return true;
  const head = text.slice(0, 200).toLowerCase();
  return (
    head.startsWith("<system-reminder>") ||
    head.startsWith("[system reminder]") ||
    head.includes("# vercel plugin session context")
  );
}

// List all Claude projects on disk with session counts. Used by the
// left sidebar to populate "pick a project" → "pick a session" UI.
async function listClaudeProjects() {
  if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) return [];
  const entries = await fs.promises.readdir(CLAUDE_PROJECTS_DIR);
  const projects = [];
  for (const dirName of entries) {
    const dirPath = path.join(CLAUDE_PROJECTS_DIR, dirName);
    let st;
    try { st = await fs.promises.stat(dirPath); }
    catch { continue; }
    if (!st.isDirectory()) continue;
    const files = (await fs.promises.readdir(dirPath)).filter((f) => f.endsWith(".jsonl"));
    if (files.length === 0) continue;
    // Read one JSONL's first line to infer the real cwd (avoids the
    // lossy dirName → cwd decode for projects with spaces).
    let cwd = dirName.replace(/^-/, "/").replace(/-/g, "/");  // fallback
    const probe = path.join(dirPath, files[0]);
    try {
      const head = (await fs.promises.readFile(probe, "utf8")).split("\n", 30);
      for (const line of head) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.cwd && typeof obj.cwd === "string") { cwd = obj.cwd; break; }
        } catch {}
      }
    } catch {}
    projects.push({ dirName, cwd, label: cwd.split("/").pop() || cwd, sessionCount: files.length });
  }
  return projects;
}

// List sessions inside one project, sorted by mtime desc.
async function listSessions(cwd) {
  const dirName = encodeProjectPath(cwd);
  const dirPath = path.join(CLAUDE_PROJECTS_DIR, dirName);
  if (!fs.existsSync(dirPath)) return [];
  const files = (await fs.promises.readdir(dirPath)).filter((f) => f.endsWith(".jsonl"));
  const out = [];
  for (const f of files) {
    const fp = path.join(dirPath, f);
    let st;
    try { st = await fs.promises.stat(fp); } catch { continue; }
    out.push({
      sessionId: f.replace(/\.jsonl$/, ""),
      size: st.size,
      mtimeMs: st.mtimeMs,
    });
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

module.exports = {
  CLAUDE_PROJECTS_DIR,
  encodeProjectPath,
  findSessionJsonl,
  parseClaudeJsonl,
  listClaudeProjects,
  listSessions,
};
