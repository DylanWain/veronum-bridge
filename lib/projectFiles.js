/**
 * lib/projectFiles.js — sandboxed file tree + reader for the chat UI's
 * "see the real code from this session's project" surface.
 *
 * Two endpoints feed it:
 *
 *   GET /api/files/tree?cwd=<path>&rel=<subpath>
 *     One level of children at cwd/rel. Lazy-loaded so a 5000-file
 *     project isn't streamed all at once. Filters out the noisy
 *     directories that nobody wants to see in a file picker:
 *     node_modules, .git, dist, build, .next, .turbo, .venv, etc.
 *
 *   GET /api/files/read?cwd=<path>&rel=<relpath>
 *     File contents + detected language tag for the syntax-highlight
 *     layer. Refuses anything outside the cwd (incl. symlinks that
 *     try to escape via realpath).
 *
 * Security model: the sandbox is "you can read anywhere under the
 * session's cwd, but nowhere else." The cwd itself is supplied by the
 * client (the browser knows it from state.project.cwd), so a malicious
 * client could ASK for any cwd they want — but they can only see what
 * the daemon's own POSIX permissions allow them to see anyway. The
 * tunnel + Supabase auth already gates "who can reach this daemon."
 * For the MVP that's the right model; we tighten later by validating
 * the cwd against the known Claude/Cursor session dirs.
 */

"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

// Directories we always hide from the tree because they're either huge,
// generated, or sensitive. Users almost never want to scroll through
// node_modules in a mobile-side file picker.
const HIDDEN_DIRS = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".parcel-cache",
  ".vercel",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".DS_Store",
  ".idea",
  ".vscode",
  "target",          // Rust
  ".gradle",
]);

// File extensions we'll send as text. Binary types (images, videos,
// archives) get rejected by the reader with a 415-ish payload so the
// UI can render a "binary, not displayed" placeholder.
const TEXT_EXTENSIONS = new Set([
  // code
  "js", "jsx", "ts", "tsx", "mjs", "cjs", "json", "html", "htm", "css",
  "scss", "sass", "less", "vue", "svelte", "astro",
  "py", "rb", "go", "rs", "java", "kt", "kts", "swift", "m", "mm",
  "c", "cc", "cpp", "h", "hh", "hpp", "cs", "fs", "fsi", "fsx",
  "sh", "bash", "zsh", "fish", "ps1",
  "sql", "graphql", "gql", "proto",
  // config / data
  "md", "markdown", "mdx", "txt", "log", "yml", "yaml", "toml", "ini",
  "env", "gitignore", "dockerignore", "editorconfig", "prettierrc",
  "eslintrc", "babelrc", "lock",
  "xml", "svg", "csv", "tsv",
]);

// Map filename or extension → Prism.js language tag for syntax
// highlighting. The UI uses this as a class on <code> so Prism picks
// the right grammar.
const LANG_BY_EXT = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx",
  ts: "typescript", tsx: "tsx",
  py: "python", rb: "ruby", go: "go", rs: "rust", java: "java",
  kt: "kotlin", swift: "swift", c: "c", cc: "cpp", cpp: "cpp",
  h: "c", hh: "cpp", hpp: "cpp", cs: "csharp",
  sh: "bash", bash: "bash", zsh: "bash", fish: "bash",
  sql: "sql", graphql: "graphql", gql: "graphql",
  md: "markdown", markdown: "markdown", mdx: "markdown",
  yml: "yaml", yaml: "yaml", toml: "toml", ini: "ini",
  json: "json", html: "html", htm: "html", xml: "xml",
  css: "css", scss: "scss", sass: "sass", less: "less",
  svg: "xml", vue: "html", svelte: "html", astro: "html",
};

function detectLang(filename) {
  const lower = filename.toLowerCase();
  // Specific filename overrides (no extension)
  if (lower === "dockerfile") return "docker";
  if (lower === "makefile") return "makefile";
  if (lower === ".gitignore" || lower === ".dockerignore") return "git";
  // Extension lookup
  const ext = lower.includes(".") ? lower.split(".").pop() : "";
  return LANG_BY_EXT[ext] || "plaintext";
}

function isTextExt(filename) {
  const lower = filename.toLowerCase();
  if (!lower.includes(".")) {
    // No extension — common names we treat as text
    return ["dockerfile", "makefile", "license", "readme", "changelog"].includes(lower);
  }
  const ext = lower.split(".").pop();
  return TEXT_EXTENSIONS.has(ext);
}

// Resolve + sandbox: returns the absolute resolved path if it's inside
// cwd, throws otherwise. Uses realpath to also block symlink escapes.
async function safeResolve(cwd, rel) {
  const absCwd = path.resolve(cwd);
  const absTarget = path.resolve(absCwd, rel || ".");
  // First-pass string check (cheap, catches the obvious ..).
  if (!absTarget.startsWith(absCwd)) {
    const err = new Error("path outside project root");
    err.code = "EOUTSIDE";
    throw err;
  }
  // realpath check — only if the path exists. If it doesn't exist yet
  // (we'd block writes here later), the string check above is enough.
  try {
    const realTarget = await fsp.realpath(absTarget);
    const realCwd = await fsp.realpath(absCwd);
    if (!realTarget.startsWith(realCwd)) {
      const err = new Error("path escapes via symlink");
      err.code = "EOUTSIDE";
      throw err;
    }
    return realTarget;
  } catch (e) {
    if (e.code === "ENOENT") return absTarget; // not-yet-existing, accept as-is
    throw e;
  }
}

// One-level directory listing. Caller can recurse by re-calling with
// child paths for the folders they expanded.
async function listDir(cwd, rel = ".") {
  const target = await safeResolve(cwd, rel);
  const entries = await fsp.readdir(target, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".env" && entry.name !== ".gitignore") {
      // Hide most dotfiles, keep a few useful ones.
      continue;
    }
    if (entry.isDirectory()) {
      if (HIDDEN_DIRS.has(entry.name)) continue;
      out.push({
        name: entry.name,
        type: "dir",
        rel: path.posix.join(rel === "." ? "" : rel, entry.name),
      });
    } else if (entry.isFile()) {
      let size = 0;
      try {
        const stat = await fsp.stat(path.join(target, entry.name));
        size = stat.size;
      } catch { /* deleted between readdir and stat — skip */ }
      out.push({
        name: entry.name,
        type: "file",
        rel: path.posix.join(rel === "." ? "" : rel, entry.name),
        size,
      });
    }
    // Symlinks, sockets, fifos: skip silently.
  }
  // Sort: folders first, then files, both alphabetical (case-insensitive).
  out.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
  return out;
}

// File reader. Returns { contents, language, size } or throws.
async function readFileText(cwd, rel) {
  const target = await safeResolve(cwd, rel);
  const stat = await fsp.stat(target);
  if (!stat.isFile()) {
    const err = new Error("not a file");
    err.code = "ENOTFILE";
    throw err;
  }
  // 2 MB cap. Real source files are well under this; massive log / json
  // files would freeze the UI's Prism highlighter.
  const MAX_BYTES = 2 * 1024 * 1024;
  if (stat.size > MAX_BYTES) {
    const err = new Error(`file too large (${stat.size} bytes, max ${MAX_BYTES})`);
    err.code = "E2BIG";
    throw err;
  }
  const filename = path.basename(target);
  if (!isTextExt(filename)) {
    const err = new Error("binary or unrecognized type");
    err.code = "EBINARY";
    throw err;
  }
  const contents = await fsp.readFile(target, "utf8");
  return {
    contents,
    language: detectLang(filename),
    size: stat.size,
    filename,
  };
}

// ─── Express mount ────────────────────────────────────────────────────
function mountProjectFiles(app) {
  app.get("/api/files/tree", async (req, res) => {
    const cwd = String(req.query.cwd || "");
    const rel = String(req.query.rel || ".");
    if (!cwd) return res.status(400).json({ ok: false, error: "cwd required" });
    if (!fs.existsSync(cwd)) return res.status(404).json({ ok: false, error: "cwd not found" });
    try {
      const entries = await listDir(cwd, rel);
      res.json({ ok: true, cwd, rel, entries });
    } catch (e) {
      const code = e.code === "EOUTSIDE" ? 403 : 500;
      res.status(code).json({ ok: false, error: e.message, code: e.code });
    }
  });

  app.get("/api/files/read", async (req, res) => {
    const cwd = String(req.query.cwd || "");
    const rel = String(req.query.rel || "");
    if (!cwd || !rel) return res.status(400).json({ ok: false, error: "cwd + rel required" });
    try {
      const data = await readFileText(cwd, rel);
      res.json({ ok: true, ...data });
    } catch (e) {
      const code = e.code === "EOUTSIDE" ? 403
        : e.code === "ENOENT" ? 404
        : e.code === "E2BIG" ? 413
        : e.code === "EBINARY" ? 415
        : 500;
      res.status(code).json({ ok: false, error: e.message, code: e.code });
    }
  });
}

module.exports = { mountProjectFiles, listDir, readFileText };
