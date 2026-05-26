/**
 * lib/jsonlCache.js — in-memory LRU cache for parsed Claude / Cursor
 * JSONL session files.
 *
 * Why: both readers (Claude in main.js, Cursor in lib/cursor.js) used
 * to fs.readFile + split + JSON.parse the entire file on every
 * getSession call. For Claude sessions that can be tens of MB this
 * stalled the main process every time the user switched sessions in
 * the sidebar — visible as a 200–800ms freeze.
 *
 * What: cache the PARSED result keyed by absolute file path. On lookup
 * we stat the file and only re-parse if size or mtimeMs changed.
 * Cap at MAX entries (LRU eviction) so we don't accumulate memory.
 *
 * Cache invariant: callers never mutate the returned value — it is the
 * literal cached object reference. Electron IPC serializes on its way
 * out to the renderer so renderer-side mutation is isolated.
 */

const fs = require("node:fs");

const MAX_ENTRIES = 8;
// Map insertion order = LRU order; oldest is at the start.
const cache = new Map();

/**
 * Run `parseFn(filePath)` if the cache is cold or stale, otherwise
 * return the cached parsed value. `parseFn` must be async or return
 * a Promise — receive the absolute file path.
 */
async function getOrParse(filePath, parseFn) {
  if (typeof filePath !== "string" || !filePath) {
    return parseFn(filePath);
  }
  let st;
  try {
    st = await fs.promises.stat(filePath);
  } catch {
    // File missing or unreadable. Let the parser surface its own error.
    cache.delete(filePath);
    return parseFn(filePath);
  }
  const hit = cache.get(filePath);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) {
    // Refresh LRU position so this entry isn't evicted on the next miss.
    cache.delete(filePath);
    cache.set(filePath, hit);
    return hit.value;
  }
  const value = await parseFn(filePath);
  cache.set(filePath, { size: st.size, mtimeMs: st.mtimeMs, value });
  while (cache.size > MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
  return value;
}

/** Drop a specific path. Call after a write that bypasses the
 *  parser (e.g. mirror writes) so the next read re-parses. */
function invalidate(filePath) {
  if (typeof filePath === "string") cache.delete(filePath);
}

/** Drop everything. Useful on identity change / sign-out. */
function clear() {
  cache.clear();
}

module.exports = { getOrParse, invalidate, clear };
