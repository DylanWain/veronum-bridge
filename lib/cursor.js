/**
 * Cursor adapter — surface the user's interactive `cursor-agent` CLI
 * sessions in Veronum so people who code with Cursor get the same
 * collaborative chat / composer / file-watch experience Veronum already
 * gives Claude Code users.
 *
 * Two storage layers we read:
 *
 *   1. Cursor IDE workspaces (project discovery)
 *      ~/Library/Application Support/Cursor/User/workspaceStorage/<id>/workspace.json
 *      → folder URI for each project the user has opened in Cursor.
 *
 *   2. Cursor Agent CLI transcripts (interactive sessions)
 *      ~/.cursor/projects/<dashed-cwd>/agent-transcripts/<sessionId>/<sessionId>.jsonl
 *      → newline-JSON of `{role: "user"|"assistant", message:{content:[{type,text}]}}`
 *      written by `cursor-agent` (and the IDE's terminal mode).
 *
 * We never write to Cursor's storage — `cursor-agent` itself owns
 * transcript writes when Veronum spawns it via lib/cursorAgent.js.
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const jsonlCache = require("./jsonlCache");

const CURSOR_USER_DIR = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "Cursor",
  "User",
);
const WORKSPACE_DIR = path.join(CURSOR_USER_DIR, "workspaceStorage");
const AGENT_PROJECTS_DIR = path.join(os.homedir(), ".cursor", "projects");

const SAFE_ID = /^[A-Za-z0-9_\-]{1,128}$/;

/** Cursor encodes a cwd into a project-dir name by:
 *    1. dropping leading slash
 *    2. replacing each `/` and ` ` with `-`
 *  e.g. `/Users/dylanwain/db broken up` → `Users-dylanwain-db-broken-up`.
 *  This matches what the live cursor-agent CLI produces on disk. */
function dashedCwd(cwd) {
  if (typeof cwd !== "string" || !cwd) return "";
  let out = cwd.startsWith("/") ? cwd.slice(1) : cwd;
  return out.replace(/[/\s]/g, "-");
}

function isAvailable() {
  try { return fs.statSync(CURSOR_USER_DIR).isDirectory(); }
  catch { return false; }
}

function listProjects() {
  if (!isAvailable()) return [];
  let entries;
  try { entries = fs.readdirSync(WORKSPACE_DIR, { withFileTypes: true }); }
  catch { return []; }
  const projects = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const meta = path.join(WORKSPACE_DIR, e.name, "workspace.json");
    let folder = null;
    try {
      const j = JSON.parse(fs.readFileSync(meta, "utf-8"));
      folder = j.folder; // file:///<path>
    } catch { continue; }
    if (typeof folder !== "string" || !folder.startsWith("file://")) continue;
    let p;
    try { p = decodeURIComponent(folder.replace(/^file:\/\//, "")); }
    catch { continue; }
    if (!p) continue;
    let mtime = 0;
    try { mtime = fs.statSync(meta).mtimeMs; } catch { /* ignore */ }
    // Each project's id is its absolute cwd — that's what main.js needs
    // to spawn `cursor-agent --workspace <cwd>`. The workspaceStorage
    // hash from v0.1.50 is dropped: it doesn't matter for the CLI flow.
    projects.push({
      id: p,
      name: path.basename(p) || p,
      fullPath: p,
      lastMtime: mtime,
    });
  }
  // Dedupe — Cursor sometimes has multiple workspaceStorage entries
  // pointing at the same folder.
  const seen = new Set();
  const deduped = [];
  for (const p of projects) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    deduped.push(p);
  }
  deduped.sort((a, b) => b.lastMtime - a.lastMtime);
  return deduped;
}

/**
 * List `cursor-agent` CLI transcripts for a given workspace cwd.
 * Each agent-transcripts/<sessionId>/<sessionId>.jsonl is one session.
 */
function listSessions(cwd) {
  if (typeof cwd !== "string" || !cwd) return [];
  const dashed = dashedCwd(cwd);
  if (!dashed) return [];
  const tDir = path.join(AGENT_PROJECTS_DIR, dashed, "agent-transcripts");
  let entries;
  try { entries = fs.readdirSync(tDir, { withFileTypes: true }); }
  catch { return []; }
  const sessions = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const sid = e.name;
    if (!SAFE_ID.test(sid)) continue;
    const jsonlPath = path.join(tDir, sid, `${sid}.jsonl`);
    let stat;
    try { stat = fs.statSync(jsonlPath); }
    catch { continue; }
    let title = "(new chat)";
    try {
      const head = fs.readFileSync(jsonlPath, "utf-8").split("\n", 1)[0];
      const obj = JSON.parse(head);
      const txt = extractFirstText(obj);
      if (txt) title = stripUserQueryWrapper(txt).split("\n", 1)[0].slice(0, 80);
    } catch { /* keep default title */ }
    sessions.push({
      sessionId: sid,
      title,
      mtime: stat.mtimeMs,
      size: stat.size,
    });
  }
  sessions.sort((a, b) => b.mtime - a.mtime);
  return sessions;
}

/**
 * Read every turn in a transcript and shape it for the renderer.
 * Returns `{ ok, title, messages: [{role, text, bubbleId}] }`.
 */
async function getSession(cwd, sessionId) {
  if (typeof cwd !== "string" || !cwd) {
    return { ok: false, error: "cwd required" };
  }
  if (!SAFE_ID.test(String(sessionId || ""))) {
    return { ok: false, error: "invalid session id" };
  }
  const dashed = dashedCwd(cwd);
  const jsonlPath = path.join(
    AGENT_PROJECTS_DIR, dashed, "agent-transcripts", sessionId, `${sessionId}.jsonl`,
  );
  return jsonlCache.getOrParse(jsonlPath, parseCursorJsonl);
}

/** Parser bound to the JSONL path. Pulled out so the cache layer can
 *  drive it; the failure shape (`{ ok: false, error }`) is preserved
 *  so the IPC contract with the renderer stays identical. */
async function parseCursorJsonl(jsonlPath) {
  let raw;
  try { raw = await fs.promises.readFile(jsonlPath, "utf-8"); }
  catch (e) { return { ok: false, error: e.message }; }
  const lines = raw.split("\n").filter(Boolean);
  const messages = [];
  let title = "";
  let userIdx = 0;
  let asstIdx = 0;
  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const role = obj.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = stripUserQueryWrapper(extractFirstText(obj));
    if (!text.trim()) continue;
    if (!title && role === "user") title = text.split("\n", 1)[0].slice(0, 80);
    const bubbleId =
      role === "user" ? `u-${userIdx++}` : `a-${asstIdx++}`;
    messages.push({ role, text, bubbleId });
  }
  return { ok: true, title, messages };
}

/** Pull the first text-typed content block from a Cursor JSONL record. */
function extractFirstText(obj) {
  if (!obj || typeof obj !== "object") return "";
  const msg = obj.message;
  if (!msg || typeof msg !== "object") return "";
  const content = msg.content;
  if (!Array.isArray(content)) return "";
  for (const c of content) {
    if (c && typeof c === "object" && c.type === "text" && typeof c.text === "string") {
      return c.text;
    }
  }
  return "";
}

/** Cursor wraps user prompts in `<user_query>...</user_query>` for the
 *  model. Strip it for display. Tolerant of missing closing tag. */
function stripUserQueryWrapper(text) {
  if (typeof text !== "string") return "";
  const open = text.indexOf("<user_query>");
  if (open === -1) return text;
  const after = text.slice(open + "<user_query>".length);
  const close = after.indexOf("</user_query>");
  if (close === -1) return after.trim();
  return after.slice(0, close).trim();
}

module.exports = {
  isAvailable,
  listProjects,
  listSessions,
  getSession,
  dashedCwd,
};
