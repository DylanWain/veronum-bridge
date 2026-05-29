/**
 * lib/vscode.js — VS Code workspace adapter.
 *
 * Same pattern as lib/cursor.js: scans VS Code's per-workspace
 * storage directory and surfaces each opened folder as a project.
 * Unlike Cursor, there's no agent-transcript layer — VS Code is a
 * plain editor, so each "project" is just (cwd, name) with a recency
 * timestamp from the workspace storage's mtime.
 *
 * Storage layout on macOS:
 *   ~/Library/Application Support/Code/User/workspaceStorage/<hash>/workspace.json
 *   → { "folder": "file:///Users/.../my-project" }
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const CODE_USER_DIR = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "Code",
  "User",
);
const WORKSPACE_DIR = path.join(CODE_USER_DIR, "workspaceStorage");

function isAvailable() {
  try { return fs.statSync(CODE_USER_DIR).isDirectory(); }
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
      folder = j.folder;
    } catch { continue; }
    if (typeof folder !== "string" || !folder.startsWith("file://")) continue;
    let p;
    try { p = decodeURIComponent(folder.replace(/^file:\/\//, "")); }
    catch { continue; }
    if (!p) continue;
    // Skip projects whose folder is missing from disk — VS Code keeps
    // workspace metadata for ages even after the user deletes/moves
    // the actual folder; surfacing them would mean a dead "open
    // project" link.
    try {
      if (!fs.statSync(p).isDirectory()) continue;
    } catch { continue; }
    let mtime = 0;
    try { mtime = fs.statSync(meta).mtimeMs; } catch { /* ignore */ }
    projects.push({
      id: p,
      name: path.basename(p) || p,
      fullPath: p,
      lastMtime: mtime,
    });
  }
  // Dedupe by cwd — VS Code can leave multiple workspaceStorage
  // entries pointing at the same folder after schema migrations.
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

module.exports = { isAvailable, listProjects };
