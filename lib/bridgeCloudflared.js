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
let _healthCheckTimer = null;
let _consecutiveUnhealthy = 0;

// ─── Health check ─────────────────────────────────────────────────────────
// Cloudflare's edge sometimes retires a quick-tunnel URL while our local
// cloudflared subprocess thinks it's still happily connected — the
// process keeps running, the URL still prints in our log, but DNS for
// that subdomain returns NXDOMAIN. Anyone hitting the URL gets an ISP-
// level NXDOMAIN page (Spectrum, etc.) or a generic browser error.
//
// We can't detect this by watching the cloudflared process — it has no
// idea its URL has been revoked. We have to verify externally. We do
// it via Cloudflare's DNS-over-HTTPS endpoint (1.1.1.1) which:
//   1. Bypasses the user's potentially-hijacked ISP DNS
//   2. Tells us what Cloudflare itself thinks of the hostname
//   3. Works over HTTPS so it isn't intercepted by transparent proxies
//
// If two consecutive checks return NXDOMAIN we kill cloudflared, which
// triggers the existing restart path with backoff and a fresh URL.
const HEALTH_CHECK_INTERVAL_MS = 60_000;
const HEALTH_CHECK_TIMEOUT_MS = 5_000;
const UNHEALTHY_THRESHOLD = 2; // two strikes before forcing a restart

async function isTunnelHealthy() {
  if (!_currentUrl) return false;
  const host = _currentUrl.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=A`,
      {
        headers: { Accept: "application/dns-json" },
        signal: controller.signal,
      },
    );
    if (!res.ok) return false;
    const data = await res.json();
    // RFC 8484 "Status" field: 0 = NOERROR, 3 = NXDOMAIN. Any non-zero
    // status (including the SERVFAIL Cloudflare returns for retired
    // quick tunnels) means the URL is not live.
    return data.Status === 0 && Array.isArray(data.Answer) && data.Answer.length > 0;
  } catch {
    // Network error talking to 1.1.1.1 — could be a flaky connection,
    // not necessarily a dead tunnel. Don't increment unhealthy counter
    // in this case; treat as inconclusive.
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function startHealthCheck() {
  if (_healthCheckTimer) clearInterval(_healthCheckTimer);
  _consecutiveUnhealthy = 0;
  _healthCheckTimer = setInterval(async () => {
    if (_shuttingDown || !_child) return;
    const healthy = await isTunnelHealthy();
    if (healthy === null) return; // inconclusive — don't tally
    if (healthy) {
      _consecutiveUnhealthy = 0;
      return;
    }
    _consecutiveUnhealthy += 1;
    console.warn(
      `[cloudflared] tunnel ${_currentUrl} failed health check (${_consecutiveUnhealthy}/${UNHEALTHY_THRESHOLD})`,
    );
    if (_consecutiveUnhealthy >= UNHEALTHY_THRESHOLD) {
      console.warn(`[cloudflared] forcing restart — Cloudflare edge retired the URL`);
      _consecutiveUnhealthy = 0;
      try {
        _child.kill("SIGTERM");
      } catch { /* already dead */ }
      // The 'exit' handler will call scheduleRestart() with backoff,
      // which spawns a fresh cloudflared that gets a new URL. The
      // onUrl callback then publishes the new URL to Supabase.
    }
  }, HEALTH_CHECK_INTERVAL_MS);
}

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
  startHealthCheck();
}

function getCurrentUrl() {
  return _currentUrl;
}

function shutdown() {
  _shuttingDown = true;
  if (_healthCheckTimer) {
    clearInterval(_healthCheckTimer);
    _healthCheckTimer = null;
  }
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
