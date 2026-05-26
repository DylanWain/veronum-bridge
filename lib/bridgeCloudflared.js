/**
 * lib/bridgeCloudflared.js — manages a cloudflared `quick tunnel` so the
 * paired browser session can reach this Mac's localhost:3001 from
 * anywhere on the public internet.
 *
 * Why this module exists:
 *
 *   Without it, someone has to start `cloudflared tunnel --url ...`
 *   by hand, copy the trycloudflare.com URL into Supabase, and
 *   re-copy it any time cloudflared restarts (which happens on every
 *   sleep/wake, network change, or daemon restart). That's what we
 *   were doing — and it broke as soon as the user tried to test on a
 *   second device while cloudflared was thrashing on a known QUIC
 *   datagram-handler bug, returning a 530 "origin has been
 *   unregistered" because Cloudflare's edge still had the hostname
 *   routed but no live origin client.
 *
 * What this module does:
 *
 *   1. Spawn cloudflared as a child process with `--protocol http2`
 *      (avoids the QUIC datagram-handler bug in 2026.5.x — when QUIC
 *      datagram setup fails, the entire tunnel control stream tears
 *      down and retries every ~30s instead of degrading gracefully).
 *
 *   2. Parse its stderr line-by-line. The URL is printed exactly once
 *      at startup inside a banner — match `https://*.trycloudflare.com`
 *      and report it through `onUrl(url)` so the daemon can publish it
 *      to Supabase via the heartbeat RPC.
 *
 *   3. On unexpected exit, restart with exponential backoff (2s →
 *      4s → 8s → 16s → 32s, capped at 32s). cloudflared will get a
 *      *new* trycloudflare hostname every restart since these are
 *      session-tied URLs — the URL change flows back through onUrl
 *      and is picked up on the next heartbeat.
 *
 * Public API:
 *
 *   init({ onUrl })  — start the cloudflared process. Calls onUrl(url)
 *                       once per URL change. Idempotent.
 *   getCurrentUrl()  — most recent observed URL (or null).
 *   shutdown()       — kill the child + cancel any pending restart.
 *
 * Why we don't bundle cloudflared inside the .app:
 *
 *   Universal-2 cloudflared is ~40 MB. Users with brew already have
 *   it. We resolve `cloudflared` via PATH (overridable with
 *   VERONUM_CLOUDFLARED_BIN). The menu-bar app can later detect
 *   "binary not found" and offer to install via brew or download.
 */

"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

// ─── Binary resolution ─────────────────────────────────────────────────────
// Order of preference:
//   1. VERONUM_CLOUDFLARED_BIN env override (escape hatch for testing)
//   2. Bundled universal binary at bin/cloudflared (the canonical path
//      in shipped DMGs — electron-builder asarUnpacks bin/** so the
//      binary lives at .app/Contents/Resources/app.asar.unpacked/bin/)
//   3. "cloudflared" on PATH (dev-machine fallback; works when launched
//      from a shell that has /opt/homebrew/bin on PATH, but a user
//      double-clicking the .app from Finder has a stripped PATH that
//      excludes /opt/homebrew, so bundling is the real fix)
function resolveCloudflaredBin() {
  if (process.env.VERONUM_CLOUDFLARED_BIN) return process.env.VERONUM_CLOUDFLARED_BIN;
  // __dirname here is .../lib (dev) or .../app.asar/lib (packaged).
  // bin/ is one level up. In the packaged case, electron-builder
  // unpacks `bin/**` to app.asar.unpacked, so we redirect the path.
  const fromAsar = __dirname.includes("app.asar");
  const libDir = fromAsar
    ? __dirname.replace(/\/app\.asar\//, "/app.asar.unpacked/")
    : __dirname;
  const bundled = path.join(libDir, "..", "bin", "cloudflared");
  if (fs.existsSync(bundled)) return bundled;
  return "cloudflared";
}

// ─── Configuration ─────────────────────────────────────────────────────────
const CLOUDFLARED_BIN = resolveCloudflaredBin();
const TARGET_PORT = parseInt(process.env.PORT || "3001", 10);
const RESTART_BACKOFF_MS = [2_000, 4_000, 8_000, 16_000, 32_000];

// Match the URL cloudflared prints once at startup. Pattern matches
// kebab-case word IDs cloudflared generates (length varies; 3–5 words).
const TRYCLOUDFLARE_REGEX = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

// ─── Module state ──────────────────────────────────────────────────────────
let _child = null;
let _currentUrl = null;
let _onUrl = () => {};
let _restartTimer = null;
let _restartAttempts = 0;
let _shuttingDown = false;

// ─── stdin/stderr line buffer helper ──────────────────────────────────────
// cloudflared logs to STDERR (yes, even the success banner). We buffer
// partial chunks and emit on newlines so multi-line splits don't drop
// the URL match if it lands at a chunk boundary.
function makeLineEmitter(onLine) {
  let buf = "";
  return (chunk) => {
    buf += chunk.toString("utf8");
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) onLine(line);
  };
}

// ─── Spawn + watch ─────────────────────────────────────────────────────────
function spawnOnce() {
  if (_shuttingDown) return;
  const args = [
    "tunnel",
    "--protocol", "http2",
    "--no-autoupdate",
    "--url", `http://localhost:${TARGET_PORT}`,
  ];
  console.log(`[cloudflared] spawning: ${CLOUDFLARED_BIN} ${args.join(" ")}`);

  let child;
  try {
    child = spawn(CLOUDFLARED_BIN, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
  } catch (err) {
    // ENOENT etc. — binary missing from PATH. Schedule a retry but
    // also log loudly; the menu-bar app should surface this.
    console.warn(`[cloudflared] spawn failed: ${err.message}`);
    scheduleRestart();
    return;
  }

  _child = child;

  const onLine = (line) => {
    const m = line.match(TRYCLOUDFLARE_REGEX);
    if (m && m[0] !== _currentUrl) {
      const url = m[0];
      _currentUrl = url;
      _restartAttempts = 0; // healthy — reset backoff
      console.log(`[cloudflared] URL → ${url}`);
      try { _onUrl(url); } catch (e) {
        console.warn(`[cloudflared] onUrl handler threw: ${e.message}`);
      }
    }
  };

  child.stderr.on("data", makeLineEmitter(onLine));
  child.stdout.on("data", makeLineEmitter(onLine));

  child.on("error", (err) => {
    // Usually fired alongside an exit; just log here.
    console.warn(`[cloudflared] process error: ${err.message}`);
  });

  child.on("exit", (code, signal) => {
    if (_shuttingDown) return;
    console.warn(
      `[cloudflared] exited (code=${code}, signal=${signal}) — scheduling restart`,
    );
    _child = null;
    _currentUrl = null;
    scheduleRestart();
  });
}

function scheduleRestart() {
  if (_shuttingDown) return;
  if (_restartTimer) clearTimeout(_restartTimer);
  const idx = Math.min(_restartAttempts, RESTART_BACKOFF_MS.length - 1);
  const delay = RESTART_BACKOFF_MS[idx];
  _restartAttempts += 1;
  console.log(`[cloudflared] restart in ${delay}ms (attempt ${_restartAttempts})`);
  _restartTimer = setTimeout(() => {
    _restartTimer = null;
    spawnOnce();
  }, delay);
}

// ─── Public API ────────────────────────────────────────────────────────────
function init({ onUrl } = {}) {
  if (typeof onUrl === "function") _onUrl = onUrl;
  if (_child || _restartTimer) return; // idempotent
  spawnOnce();
}

function getCurrentUrl() {
  return _currentUrl;
}

function shutdown() {
  _shuttingDown = true;
  if (_restartTimer) {
    clearTimeout(_restartTimer);
    _restartTimer = null;
  }
  if (_child) {
    try { _child.kill("SIGTERM"); } catch { /* already dead */ }
    _child = null;
  }
  _currentUrl = null;
}

module.exports = { init, getCurrentUrl, shutdown };
