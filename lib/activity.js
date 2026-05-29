/**
 * lib/activity.js — "Recent edits" feed for the workspace panel.
 *
 * Surfaces every file edit Claude / Cursor / the in-app editor has
 * made for a given session+cwd, with the old/new text needed to render
 * red/green diffs in the UI. Each edit gets a stable id derived from
 * (source, ts, filePath, hashed content) so user-given names persist
 * across reloads — the names live in <cwd>/.veronum/edits.json.
 *
 *   GET  /api/activity?source=claude|cursor|user&cwd=...&id=<session_id>
 *     → { ok, edits: [{ id, ts, source, filePath, relPath, before, after,
 *                       added, removed, name }] }
 *
 *   POST /api/activity/name { cwd, id, name }
 *     → { ok }
 *
 * For "user" source we also read .veronum/edits.json so the in-app
 * editor's saves (recorded by /api/files/write) show up alongside AI
 * edits in the same feed.
 */

"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const claudeReader = require("./claudeReader");
const cursorReader = require("./cursor");

const META_DIR = ".veronum";
const META_FILE = "edits.json";

function metaPath(cwd) {
  return path.join(cwd, META_DIR, META_FILE);
}

async function readMeta(cwd) {
  try {
    const raw = await fsp.readFile(metaPath(cwd), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch { return {}; }
}

async function writeMeta(cwd, data) {
  const dir = path.join(cwd, META_DIR);
  try { await fsp.mkdir(dir, { recursive: true }); } catch { /* ignore */ }
  await fsp.writeFile(metaPath(cwd), JSON.stringify(data, null, 2), "utf8");
}

// Stable id for an edit. We hash (source, ts, filePath, hash of before+after)
// so the same logical edit always produces the same id — which is what
// makes user-given names persist.
function editId({ source, ts, filePath, before, after }) {
  const h = crypto.createHash("sha1");
  h.update(source);
  h.update("|");
  h.update(String(ts));
  h.update("|");
  h.update(filePath || "");
  h.update("|");
  h.update(String(before || "").length + ":" + String(after || "").length);
  h.update("|");
  h.update(String(before || "").slice(0, 256));
  h.update("|");
  h.update(String(after || "").slice(0, 256));
  return h.digest("hex").slice(0, 16);
}

// Line-count diff. We deliberately don't compute LCS here — the
// client renders the diff and a quick added/removed estimate is fine
// for the list summary.
function diffSummary(before, after) {
  const a = String(before || "");
  const b = String(after || "");
  if (a === b) return { added: 0, removed: 0 };
  const al = a.split("\n");
  const bl = b.split("\n");
  // Strip common prefix/suffix lines so the count reflects actual edits.
  let i = 0;
  while (i < al.length && i < bl.length && al[i] === bl[i]) i++;
  let j = 0;
  while (
    j < al.length - i &&
    j < bl.length - i &&
    al[al.length - 1 - j] === bl[bl.length - 1 - j]
  ) j++;
  const removed = Math.max(0, al.length - i - j);
  const added = Math.max(0, bl.length - i - j);
  return { added, removed };
}

// Walk a Claude JSONL and pull out every Edit / MultiEdit / Write
// tool_use record. Returns an array of edit entries (newest first).
async function scanClaudeJsonl(filePath) {
  let raw;
  try { raw = await fsp.readFile(filePath, "utf8"); }
  catch { return []; }
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const ts = obj.timestamp ? new Date(obj.timestamp).getTime() : 0;
    const msg = obj.message || {};
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || block.type !== "tool_use") continue;
      const name = block.name;
      const input = block.input || {};
      if (name === "Edit" && typeof input.file_path === "string") {
        out.push({
          source: "claude",
          ts,
          filePath: input.file_path,
          before: input.old_string ?? "",
          after: input.new_string ?? "",
        });
      } else if (name === "MultiEdit" && typeof input.file_path === "string" && Array.isArray(input.edits)) {
        // Surface each sub-edit as its own entry. Keeps the list
        // granular enough for users to name individual changes.
        for (const e of input.edits) {
          out.push({
            source: "claude",
            ts,
            filePath: input.file_path,
            before: e?.old_string ?? "",
            after: e?.new_string ?? "",
          });
        }
      } else if (name === "Write" && typeof input.file_path === "string") {
        // Write replaces the whole file — we don't have the "before".
        // Show as a special "wrote N bytes" entry with no diff.
        out.push({
          source: "claude",
          ts,
          filePath: input.file_path,
          before: null,
          after: input.content ?? "",
          isWrite: true,
        });
      }
    }
  }
  return out;
}

// Cursor's transcript shape is different — tool calls live in
// `assistant`-type messages with a `tool_calls` array (or similar).
// Parse defensively: only emit entries we can recognize.
async function scanCursorJsonl(filePath) {
  let raw;
  try { raw = await fsp.readFile(filePath, "utf8"); }
  catch { return []; }
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const ts = obj.timestamp ? new Date(obj.timestamp).getTime()
      : obj.created_at ? new Date(obj.created_at).getTime()
      : 0;
    // Cursor's tool calls can appear nested under message.tool_calls or
    // content.tool_use. We scan a few shapes.
    const candidates = [];
    if (Array.isArray(obj?.message?.tool_calls)) candidates.push(...obj.message.tool_calls);
    if (Array.isArray(obj?.tool_calls)) candidates.push(...obj.tool_calls);
    if (Array.isArray(obj?.message?.content)) {
      for (const b of obj.message.content) {
        if (b?.type === "tool_use") candidates.push({ name: b.name, input: b.input });
      }
    }
    for (const c of candidates) {
      const name = c?.name || c?.function?.name;
      let input = c?.input || c?.function?.arguments;
      if (typeof input === "string") { try { input = JSON.parse(input); } catch { input = {}; } }
      input = input || {};
      const fp = input.file_path || input.path || input.target_file;
      if (!fp || typeof fp !== "string") continue;
      const lower = String(name || "").toLowerCase();
      if (lower === "edit" || lower === "edit_file" || lower === "replace_in_file") {
        out.push({
          source: "cursor", ts, filePath: fp,
          before: input.old_string ?? input.original ?? "",
          after: input.new_string ?? input.replacement ?? "",
        });
      } else if (lower === "write" || lower === "write_file" || lower === "create_file") {
        out.push({
          source: "cursor", ts, filePath: fp,
          before: null,
          after: input.content ?? input.text ?? "",
          isWrite: true,
        });
      }
    }
  }
  return out;
}

// Read the in-app editor's persisted save log (we append to it from
// the /api/files/write handler — see mountActivity for the hook).
async function readUserEdits(cwd) {
  try {
    const meta = await readMeta(cwd);
    return Array.isArray(meta._userEdits) ? meta._userEdits : [];
  } catch { return []; }
}

// Helper used by /api/files/write AND undo/redo to record a change
// into the activity feed. `opts.source` defaults to "user" (in-app
// editor save); pass "undo"/"redo" with `opts.undoneId` for chained
// time-travel entries. Keeps the last 300 entries so the file doesn't
// grow forever.
async function recordUserEdit({ cwd, relPath, before, after }, opts = {}) {
  if (!cwd) return null;
  const meta = await readMeta(cwd);
  const ts = Date.now();
  const filePath = path.resolve(cwd, relPath);
  const entry = {
    source: opts.source || "user",
    ts,
    filePath,
    before: before == null ? null : String(before),
    after: String(after || ""),
  };
  entry.id = editId(entry);
  if (opts.undoneId) entry.undoneId = opts.undoneId;
  const summary = diffSummary(entry.before == null ? "" : entry.before, entry.after);
  entry.added = summary.added;
  entry.removed = summary.removed;
  const list = Array.isArray(meta._userEdits) ? meta._userEdits : [];
  list.push(entry);
  if (list.length > 300) list.splice(0, list.length - 300);
  meta._userEdits = list;
  try { await writeMeta(cwd, meta); } catch { /* ignore — non-fatal */ }
  return entry;
}

function relToCwd(cwd, abs) {
  try {
    const r = path.relative(cwd, abs);
    if (r && !r.startsWith("..")) return r;
  } catch {}
  return abs;
}

async function listActivity({ source, cwd, sessionId, limit = 100 }) {
  let raw = [];
  if (source === "claude" && sessionId) {
    const found = await claudeReader.findSessionJsonl(sessionId, cwd);
    if (found?.path) raw = await scanClaudeJsonl(found.path);
  } else if (source === "cursor" && sessionId) {
    const dashed = cursorReader.dashedCwd(cwd);
    if (dashed) {
      const fp = path.join(
        os.homedir(), ".cursor", "projects", dashed,
        "agent-transcripts", sessionId, `${sessionId}.jsonl`,
      );
      raw = await scanCursorJsonl(fp);
    }
  }
  // Always merge in user edits — they're per-cwd, not per-session.
  const userEdits = await readUserEdits(cwd);
  raw = raw.concat(userEdits);

  // Augment each entry with id, relPath, added/removed counts, and
  // any persisted user name.
  const meta = await readMeta(cwd);
  const names = meta.names || {};
  const out = [];
  for (const e of raw) {
    const id = e.id || editId(e);
    const summary = (e.added != null && e.removed != null)
      ? { added: e.added, removed: e.removed }
      : diffSummary(e.before, e.after);
    out.push({
      id,
      ts: e.ts,
      source: e.source,
      filePath: e.filePath,
      relPath: relToCwd(cwd, e.filePath),
      before: e.before,
      after: e.after,
      isWrite: !!e.isWrite,
      added: summary.added,
      removed: summary.removed,
      name: names[id] || null,
      undoneId: e.undoneId || null,
    });
  }
  out.sort((a, b) => b.ts - a.ts);
  return out.slice(0, limit);
}

// Walk activity newest → oldest tracking which edits have been undone
// (via later "undo" entries) and which were re-done (via "redo"). The
// next *undoable* is the most recent edit (claude/cursor/user) that
// isn't currently in the undone set. The next *redoable* is the most
// recent "undo" entry that hasn't been redone since.
function computeUndoState(edits) {
  const undone = new Set();
  const redone = new Set();
  let nextUndo = null;
  let nextRedo = null;
  // We pass NEWEST first, so walk forward.
  for (const e of edits) {
    if (e.source === "redo" && e.undoneId) {
      redone.add(e.undoneId);
      undone.delete(e.undoneId);
    } else if (e.source === "undo" && e.undoneId) {
      if (!redone.has(e.undoneId)) {
        undone.add(e.undoneId);
        if (!nextRedo) nextRedo = e; // most recent un-redone undo
      } else {
        redone.delete(e.undoneId); // older undo that was already redone
      }
    } else if (e.source === "claude" || e.source === "cursor" || e.source === "user") {
      if (!nextUndo && !undone.has(e.id)) {
        nextUndo = e;
      }
    }
  }
  return { nextUndo, nextRedo };
}

async function undoLast({ source, cwd, sessionId }) {
  if (!cwd) throw new Error("cwd required");
  const edits = await listActivity({ source, cwd, sessionId, limit: 500 });
  const { nextUndo } = computeUndoState(edits);
  if (!nextUndo) throw new Error("nothing to undo");
  if (nextUndo.isWrite && nextUndo.before == null) {
    throw new Error("can't undo a Write — original content wasn't captured");
  }
  // Restore the file's "before" content. Sandbox-check: filePath must
  // be inside cwd (the same rule the editor save endpoint enforces).
  const absCwd = path.resolve(cwd);
  const absTarget = path.resolve(nextUndo.filePath);
  if (!absTarget.startsWith(absCwd)) {
    throw new Error("refusing to undo a file outside the project root");
  }
  // Capture what's currently on disk so we can re-do later.
  let currentOnDisk = "";
  try { currentOnDisk = await fsp.readFile(absTarget, "utf8"); }
  catch { /* file may not exist; before is what we'll restore */ }
  await fsp.mkdir(path.dirname(absTarget), { recursive: true });
  await fsp.writeFile(absTarget, nextUndo.before, "utf8");
  const entry = await recordUserEdit(
    { cwd, relPath: path.relative(cwd, absTarget), before: currentOnDisk, after: nextUndo.before },
    { source: "undo", undoneId: nextUndo.id },
  );
  return { undone: nextUndo, recorded: entry };
}

async function redoLast({ source, cwd, sessionId }) {
  if (!cwd) throw new Error("cwd required");
  const edits = await listActivity({ source, cwd, sessionId, limit: 500 });
  const { nextRedo } = computeUndoState(edits);
  if (!nextRedo) throw new Error("nothing to redo");
  // Find the original edit that was undone — its `after` is what we
  // restore on redo. The undo entry's `before` IS the original
  // `after` content (we captured it at undo time), so we can use that
  // directly without going back to the original edit.
  const target = nextRedo.before;
  if (target == null) throw new Error("redo data missing");
  const absCwd = path.resolve(cwd);
  const absTarget = path.resolve(nextRedo.filePath);
  if (!absTarget.startsWith(absCwd)) {
    throw new Error("refusing to redo a file outside the project root");
  }
  let currentOnDisk = "";
  try { currentOnDisk = await fsp.readFile(absTarget, "utf8"); }
  catch { /* ignore */ }
  await fsp.mkdir(path.dirname(absTarget), { recursive: true });
  await fsp.writeFile(absTarget, target, "utf8");
  const entry = await recordUserEdit(
    { cwd, relPath: path.relative(cwd, absTarget), before: currentOnDisk, after: target },
    { source: "redo", undoneId: nextRedo.undoneId },
  );
  return { redone: nextRedo, recorded: entry };
}

async function setEditName({ cwd, id, name }) {
  if (!cwd || !id) throw new Error("cwd + id required");
  const meta = await readMeta(cwd);
  meta.names = meta.names || {};
  if (name && String(name).trim()) {
    meta.names[id] = String(name).trim().slice(0, 120);
  } else {
    delete meta.names[id];
  }
  await writeMeta(cwd, meta);
}

function mountActivity(app) {
  app.get("/api/activity", async (req, res) => {
    try {
      const source = String(req.query.source || "");
      const cwd = String(req.query.cwd || "");
      const sessionId = req.query.id ? String(req.query.id) : null;
      if (!cwd) return res.status(400).json({ ok: false, error: "cwd required" });
      const edits = await listActivity({ source, cwd, sessionId });
      res.json({ ok: true, edits });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post("/api/activity/name", async (req, res) => {
    try {
      const { cwd, id, name } = req.body || {};
      await setEditName({ cwd, id, name });
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.post("/api/activity/undo", async (req, res) => {
    try {
      const { source, cwd, id } = req.body || {};
      const result = await undoLast({ source, cwd, sessionId: id });
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.post("/api/activity/redo", async (req, res) => {
    try {
      const { source, cwd, id } = req.body || {};
      const result = await redoLast({ source, cwd, sessionId: id });
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });
}

module.exports = {
  mountActivity,
  listActivity,
  setEditName,
  recordUserEdit,
  diffSummary,
  undoLast,
  redoLast,
  computeUndoState,
};
