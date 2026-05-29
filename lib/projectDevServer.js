/**
 * lib/projectDevServer.js — spawn the user's actual dev server.
 *
 * The original live-preview port-picker showed whatever happened to be
 * listening on localhost — usually NOT the user's project. The Katya
 * App had its dev server stopped and the picker showed Control Center
 * and rapportd instead of the app, which is nonsensical UX.
 *
 * This module fixes that by being the one who runs `npm run dev`. It:
 *   1. Reads package.json from the session's cwd
 *   2. Finds the dev (or start) script
 *   3. Spawns it as a child process in cwd
 *   4. Parses stdout/stderr for the URL or port the server announces
 *   5. Tracks the running process so we can stop it later
 *
 * One server per cwd; subsequent starts are no-ops if already running.
 *
 * Endpoints (mounted in server.js):
 *   GET  /api/preview/dev-status?cwd=...     → { running, url, status, devScript }
 *   POST /api/preview/dev-start              → { ok, url, port }   blocks ≤ 20s
 *   POST /api/preview/dev-stop               → { ok }
 */

"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");

const servers = new Map(); // cwd → entry
// Separate map for "renderer-only" static servers. An Electron project's
// renderer is the HTML/CSS/JS that displays inside the native window;
// for mobile previews we expose that renderer as a regular webpage so
// the phone can view it via the tunnel proxy. Keyed by cwd, value is
// the same shape as `servers` entries but with kind: "renderer".
const rendererServers = new Map();

// Ask the OS for an unused port — open a socket on port 0, read the
// assigned port, close. Used for the static-HTML fallback where we
// pick the port ourselves before spawning python3 http.server.
function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

// Decide whether a package.json describes an Electron app. We treat it
// as Electron when EITHER (a) a dep/devDep called electron / electron-*
// is present, OR (b) any of the user's npm scripts shells out to
// electron / electron-forge / electron-vite / electron-builder.
function isElectronProject(pkg, scripts) {
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  for (const k of Object.keys(deps)) {
    if (k === "electron" || k.startsWith("electron-") || k.startsWith("@electron-forge/")) {
      return true;
    }
  }
  for (const cmd of Object.values(scripts || {})) {
    if (typeof cmd === "string" && /\belectron(-forge|-vite|-builder)?\b/.test(cmd)) {
      return true;
    }
  }
  return false;
}

// Pick the npm script most likely to launch the Electron app. We prefer
// scripts whose command actually references electron over a generic
// `dev` that might just start a renderer Vite server in isolation.
function pickElectronScript(scripts) {
  const named = ["electron:dev", "dev:electron", "electron-dev", "start:electron", "electron", "dev", "start"];
  // First pass: a known name AND its command mentions electron.
  for (const n of named) {
    if (scripts[n] && /\belectron(-forge|-vite|-builder)?\b/.test(scripts[n])) return n;
  }
  // Second pass: ANY script whose command shells out to electron.
  for (const [n, cmd] of Object.entries(scripts)) {
    if (typeof cmd === "string" && /\belectron(-forge|-vite|-builder)?\b/.test(cmd)) return n;
  }
  // Last resort: just the known name even if its cmd doesn't match (rare).
  for (const n of named) {
    if (scripts[n]) return n;
  }
  return null;
}

function findScripts(cwd) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
    const scripts = pkg.scripts || {};
    // Electron first — these projects ALSO usually have a `dev` script,
    // but we want to treat them as native apps (no URL, just launch).
    if (isElectronProject(pkg, scripts)) {
      const name = pickElectronScript(scripts);
      if (name) {
        return { name, cmd: scripts[name], all: scripts, kind: "electron" };
      }
    }
    // Prefer dev over start; fall back to anything obvious.
    const which = scripts.dev ? "dev"
      : scripts.start ? "start"
      : scripts.serve ? "serve"
      : null;
    if (which) return { name: which, cmd: scripts[which], all: scripts, kind: "npm" };
  } catch { /* no package.json */ }
  // Static fallback: bare projects with index.html (e.g. landing pages
  // Cursor scaffolds without a package.json). We serve them ourselves
  // via python3 -m http.server so they get a real localhost URL.
  try {
    for (const name of ["index.html", "index.htm"]) {
      if (fs.statSync(path.join(cwd, name)).isFile()) {
        return { name: "static", cmd: "python3 -m http.server (auto-port)", kind: "static" };
      }
    }
  } catch { /* no index.html */ }
  return null;
}

// Extract a server URL from a chunk of dev-server output. Returns null
// if no recognizable pattern. We accept a few common shapes:
//   "Local:   http://localhost:5173/"        Vite
//   "ready - started server on 0.0.0.0:3000" Next.js
//   "Listening on port 4000"                 Express logs
//   "Server running at http://localhost:8080" CRA + many others
//   "▶ Local:   http://127.0.0.1:4321/"      Astro
function extractUrl(text) {
  // 1. Explicit http(s)://...:PORT URL.
  const explicit = text.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})\b/);
  if (explicit) return { port: parseInt(explicit[1], 10), url: `http://localhost:${explicit[1]}/` };
  // 2. "port NNNN" / "Listening on NNNN" / "on port NNNN".
  const portish = text.match(/(?:listening|running|started|ready|up)\s+(?:on\s+)?(?:port\s+)?(?:0\.0\.0\.0:|127\.0\.0\.1:|localhost:)?(\d{4,5})\b/i);
  if (portish) return { port: parseInt(portish[1], 10), url: `http://localhost:${portish[1]}/` };
  return null;
}

async function startInternal(cwd) {
  // Idempotent: if a server is running for this cwd, return it.
  const existing = servers.get(cwd);
  if (existing && existing.proc && existing.proc.exitCode === null) {
    return existing;
  }
  const found = findScripts(cwd);
  if (!found) {
    throw new Error("No package.json (dev/start/serve script) or index.html in this project.");
  }
  const entry = {
    cwd,
    script: found.name,
    cmd: found.cmd,
    proc: null,
    url: null,
    port: null,
    status: "starting",
    log: "",
    startedAt: Date.now(),
  };
  servers.set(cwd, entry);

  let proc;
  entry.kind = found.kind;
  if (found.kind === "static") {
    // Pick a free port, then spawn python3 -m http.server bound to it.
    // URL is known upfront because WE picked the port — no need to wait
    // for the process to announce itself.
    const port = await pickFreePort();
    proc = spawn("python3", ["-m", "http.server", String(port), "--bind", "127.0.0.1"], {
      cwd,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    entry.proc = proc;
    entry.port = port;
    entry.url = `http://localhost:${port}/`;
    entry.status = "running";
    console.log(`[devserver] static: "python3 -m http.server ${port}" in ${cwd} (pid=${proc.pid})`);
  } else if (found.kind === "electron") {
    // Electron: spawn the script and consider it "running" as soon as
    // the proc is alive. There's no URL — Electron is a native window
    // on the Mac. The proc.on("exit") handler downgrades status when
    // the user closes the window.
    proc = spawn("npm", ["run", found.name], {
      cwd,
      env: { ...process.env, FORCE_COLOR: "0", NODE_NO_WARNINGS: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    entry.proc = proc;
    entry.status = "running";
    console.log(`[devserver] electron: "npm run ${found.name}" in ${cwd} (pid=${proc.pid})`);
  } else {
    proc = spawn("npm", ["run", found.name], {
      cwd,
      env: { ...process.env, FORCE_COLOR: "0", NODE_NO_WARNINGS: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    entry.proc = proc;
    console.log(`[devserver] starting "npm run ${found.name}" in ${cwd} (pid=${proc.pid})`);
  }

  const handleChunk = (chunk) => {
    const text = chunk.toString("utf8");
    entry.log = (entry.log + text).slice(-8192); // keep last 8KB
    if (!entry.url) {
      const found = extractUrl(text);
      if (found) {
        entry.port = found.port;
        entry.url = found.url;
        entry.status = "running";
        console.log(`[devserver] ${cwd} → ${entry.url}`);
      }
    }
  };
  proc.stdout.on("data", handleChunk);
  proc.stderr.on("data", handleChunk);

  proc.on("exit", (code, signal) => {
    entry.status = code === 0 ? "exited" : "crashed";
    console.warn(`[devserver] ${cwd} exited code=${code} signal=${signal}`);
    // Keep the entry around briefly so /dev-status can report the
    // crash reason; clear it after 30s.
    setTimeout(() => {
      if (servers.get(cwd) === entry && entry.proc?.exitCode != null) {
        servers.delete(cwd);
      }
    }, 30_000);
  });
  proc.on("error", (err) => {
    entry.status = "error";
    entry.error = err.message;
    console.warn(`[devserver] ${cwd} spawn error: ${err.message}`);
  });

  return entry;
}

// If the dev-server output reveals an EADDRINUSE, return the port that
// was already taken. That port is almost certainly the user's previous
// run of THIS SAME dev server (or another instance of it) — we can
// preview that one instead of fighting for the port.
function findInUsePort(log) {
  // Node 22 EADDRINUSE: "  port: 4000\n}" style.
  const a = log.match(/EADDRINUSE[\s\S]{0,200}?port:\s*(\d{2,5})\b/i);
  if (a) return parseInt(a[1], 10);
  // Old-style or Express-style: "EADDRINUSE: address already in use :::4000"
  const b = log.match(/EADDRINUSE[^\d\n]*?:::(\d{2,5})\b/);
  if (b) return parseInt(b[1], 10);
  // Plain "address already in use ...:4000"
  const c = log.match(/address already in use[^\d]*?(\d{4,5})\b/i);
  if (c) return parseInt(c[1], 10);
  return null;
}

// Start the dev server and wait until it announces a URL, or timeout.
async function startAndWait(cwd, timeoutMs = 25_000) {
  const entry = await startInternal(cwd);
  // Electron has no URL to wait for — proc-alive == running. Give the
  // child up to 3s to crash on startup (npm install missing, electron
  // binary not found, esbuild errors, etc), then either throw with the
  // captured log, or return success. 500ms was too short — most failures
  // happen 1-2s in, after node/npm has bootstrapped.
  if (entry.kind === "electron") {
    const electronGraceMs = 3000;
    const t0 = Date.now();
    while (Date.now() - t0 < electronGraceMs) {
      if (entry.status === "crashed" || entry.status === "exited" || entry.status === "error") {
        const tail = entry.log.split("\n").slice(-12).join("\n") || "(no output captured)";
        throw new Error(`Electron exited before reaching steady state.\n\n${tail}`);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    return entry;
  }
  if (entry.url) return entry;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (entry.url) return entry;

    // Scan the running log for EADDRINUSE before the process even
    // exits. Some npm wrappers keep the parent alive long after the
    // child has crashed; without this fast-path we'd wait 25s for the
    // outer timeout while the answer was already in stderr.
    const stuckPort = findInUsePort(entry.log);
    if (stuckPort) {
      // Verify the port actually serves HTTP. If yes, treat it as the
      // user's dev server. If not, surface the EADDRINUSE as an error.
      const alive = await checkHttp(`http://localhost:${stuckPort}/`);
      if (alive) {
        const url = `http://localhost:${stuckPort}/`;
        console.log(`[devserver] ${cwd} → EADDRINUSE on ${stuckPort}; the running server responds, using it`);
        // Stop our own failed child if it's still flailing.
        try { entry.proc?.kill("SIGTERM"); } catch {}
        servers.set(cwd, {
          cwd,
          script: entry.script,
          cmd: entry.cmd,
          proc: null,
          url,
          port: stuckPort,
          status: "running-external",
          log: entry.log,
          startedAt: Date.now(),
        });
        return servers.get(cwd);
      }
    }

    if (entry.status === "exited" || entry.status === "crashed" || entry.status === "error") {
      const tail = entry.log.split("\n").slice(-10).join("\n");
      throw new Error(`Dev server failed to start. Last output:\n${tail}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `Dev server didn't bind a port within ${timeoutMs / 1000}s. Last output:\n` +
      entry.log.split("\n").slice(-10).join("\n"),
  );
}

// Quick HTTP liveness probe — returns true if the URL responds with
// ANY HTTP status code in <2s. Used to confirm a "stuck" port is
// actually serving content (vs a zombie socket).
async function checkHttp(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const r = await fetch(url, { signal: controller.signal, method: "GET" });
    clearTimeout(timer);
    return r.status < 600;
  } catch { return false; }
}

function status(cwd) {
  const found = findScripts(cwd);
  const entry = servers.get(cwd);
  // Web servers need entry.url to be "running"; Electron is "running"
  // as long as the proc is alive (no URL exists).
  const isElectron = (entry?.kind || found?.kind) === "electron";
  const procAlive = !!(entry?.proc && entry.proc.exitCode === null);
  const ownRunning = isElectron ? procAlive : (procAlive && !!entry?.url);
  const externalRunning = entry?.status === "running-external" && !!entry?.url;
  return {
    running: ownRunning || externalRunning,
    status: entry?.status || "idle",
    kind: entry?.kind || found?.kind || null,
    url: entry?.url || null,
    port: entry?.port || null,
    script: entry?.script || found?.name || null,
    cmd: entry?.cmd || found?.cmd || null,
    devScriptAvailable: !!found,
    pid: entry?.proc?.pid || null,
    logTail: entry?.log ? entry.log.split("\n").slice(-15).join("\n") : null,
  };
}

// Best-effort: try to find an existing dev server for a project that we
// didn't spawn ourselves. Reads the dev script for hints about the
// port; falls back to common ones. Returns {port, url} or null.
async function detectExisting(cwd) {
  const found = findScripts(cwd);
  if (!found) return null;
  // Static projects use a port WE picked when spawning them — there is
  // no meaningful "external" form to detect. Without this guard the
  // common-defaults scan below picks the FIRST alive localhost port,
  // which can be a different project entirely (e.g. claude-ui at 5173).
  if (found.kind === "static") return null;
  // Electron has no localhost URL to detect — it's a native window.
  if (found.kind === "electron") return null;
  // Extract obvious port hints from the script + any .env files.
  const hints = new Set();
  const portMatch = found.cmd.match(/--port[= ](\d{2,5})/);
  if (portMatch) hints.add(parseInt(portMatch[1], 10));
  for (const envName of [".env", ".env.local", ".env.development"]) {
    try {
      const text = fs.readFileSync(path.join(cwd, envName), "utf8");
      for (const m of text.matchAll(/(?:^|\n)(?:PORT|VITE_PORT|NEXT_PUBLIC_PORT)=(\d{2,5})/g)) {
        hints.add(parseInt(m[1], 10));
      }
    } catch {}
  }
  // README often mentions the port — cheap scan for "http://localhost:NNNN".
  try {
    const readme = fs.readFileSync(path.join(cwd, "README.md"), "utf8");
    for (const m of readme.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1):(\d{2,5})/g)) {
      hints.add(parseInt(m[1], 10));
    }
  } catch {}
  // Common defaults — try last.
  for (const p of [3000, 5173, 4000, 4321, 8080, 8000, 5000]) hints.add(p);
  for (const port of hints) {
    const url = `http://localhost:${port}/`;
    if (await checkHttp(url)) return { port, url };
  }
  return null;
}

function stop(cwd) {
  const entry = servers.get(cwd);
  if (entry?.proc) {
    try { entry.proc.kill("SIGTERM"); } catch {}
    setTimeout(() => { try { entry.proc.kill("SIGKILL"); } catch {} }, 5000);
  }
  servers.delete(cwd);
  // If a renderer-only static server was running alongside, stop it too.
  stopRenderer(cwd);
}

function stopAll() {
  for (const cwd of [...servers.keys()]) stop(cwd);
  for (const cwd of [...rendererServers.keys()]) stopRenderer(cwd);
}

// ─── Renderer-only previews (for mobile) ─────────────────────────────
// An Electron project's renderer is just HTML/CSS/JS displayed inside
// the native window. We expose it as a regular webpage so the phone
// (which can't open an Electron window) can preview the UI via the
// tunnel proxy. Two cases:
//
//   1. The project's main npm script ALREADY started a renderer dev
//      server (e.g. Vite on :5173 for veronum-overlay). dev-status's
//      entry.url is that URL — we don't need to spawn anything.
//
//   2. The project has only index.html at the cwd root (e.g. a tiny
//      `electron .` scaffold). We spawn python3 -m http.server on a
//      free port pointing at the cwd, stored in rendererServers,
//      separately from the main electron entry.

function hasIndexHtml(cwd) {
  for (const name of ["index.html", "index.htm"]) {
    try { if (fs.statSync(path.join(cwd, name)).isFile()) return true; } catch {}
  }
  return false;
}

// Returns the current renderer URL, or null if no renderer is available.
// Prefers the proc's announced URL (Vite/CRA/etc) over a separately-
// spawned static server.
function rendererStatus(cwd) {
  const dev = servers.get(cwd);
  if (dev?.url && dev?.proc && dev.proc.exitCode === null) {
    return { url: dev.url, source: "dev-server", port: dev.port };
  }
  const r = rendererServers.get(cwd);
  if (r?.proc && r.proc.exitCode === null && r.url) {
    return { url: r.url, source: "static", port: r.port };
  }
  return null;
}

// True when we COULD provide a renderer URL on demand (either an active
// proc already has one, or we can spawn a static server because
// index.html exists).
function rendererAvailable(cwd) {
  return !!rendererStatus(cwd) || hasIndexHtml(cwd);
}

async function startRenderer(cwd) {
  // If something is already serving the renderer, return it.
  const existing = rendererStatus(cwd);
  if (existing) return existing;
  if (!hasIndexHtml(cwd)) {
    throw new Error("No index.html in this project — nothing to serve as a renderer.");
  }
  const port = await pickFreePort();
  const proc = spawn("python3", ["-m", "http.server", String(port), "--bind", "127.0.0.1"], {
    cwd,
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const entry = {
    cwd, proc, port,
    url: `http://localhost:${port}/`,
    kind: "renderer",
    log: "",
    startedAt: Date.now(),
  };
  const onChunk = (c) => { entry.log = (entry.log + c.toString("utf8")).slice(-4096); };
  proc.stdout.on("data", onChunk);
  proc.stderr.on("data", onChunk);
  proc.on("exit", () => { if (rendererServers.get(cwd) === entry) rendererServers.delete(cwd); });
  rendererServers.set(cwd, entry);
  console.log(`[renderer] static: "python3 -m http.server ${port}" in ${cwd} (pid=${proc.pid})`);
  return { url: entry.url, source: "static", port };
}

function stopRenderer(cwd) {
  const entry = rendererServers.get(cwd);
  if (entry?.proc) {
    try { entry.proc.kill("SIGTERM"); } catch {}
    setTimeout(() => { try { entry.proc.kill("SIGKILL"); } catch {} }, 3000);
  }
  rendererServers.delete(cwd);
}

function mountDevServer(app) {
  // Lazy-required to avoid circular dep at module-init time.
  let _resolveProjectCwd = null;
  function resolveProjectCwd(args) {
    if (!_resolveProjectCwd) _resolveProjectCwd = require("./sessionUrlScan").resolveProjectCwd;
    return _resolveProjectCwd(args);
  }

  app.get("/api/preview/dev-status", async (req, res) => {
    const cwd = String(req.query.cwd || "");
    if (!cwd) return res.status(400).json({ ok: false, error: "cwd required" });

    let activeCwd = cwd;
    let resolvedFromSession = null;
    let s = status(cwd);

    // If the literal cwd has no project (e.g. user opened Claude in ~
    // then `cd electron-landing`'d), scan the session for the most-
    // recent project path the session actually touched and use that.
    if (!s.devScriptAvailable) {
      const source = req.query.source ? String(req.query.source) : null;
      const sessionId = req.query.id ? String(req.query.id) : (req.query.sid ? String(req.query.sid) : null);
      if (source && sessionId) {
        try {
          const inferred = await resolveProjectCwd({ source, cwd, sessionId });
          if (inferred && inferred !== cwd) {
            const inferredStatus = status(inferred);
            if (inferredStatus.devScriptAvailable) {
              activeCwd = inferred;
              resolvedFromSession = inferred;
              s = inferredStatus;
            }
          }
        } catch (e) {
          console.warn("[dev-status] session scan failed:", e.message);
        }
      }
    }

    // If we don't know of a running server for this project, check if
    // one is already up (started outside of our process — perhaps in a
    // terminal tab, or left over from a prior daemon run).
    if (!s.running) {
      const external = await detectExisting(activeCwd);
      if (external) {
        servers.set(activeCwd, {
          cwd: activeCwd,
          script: s.script,
          cmd: s.cmd,
          proc: null,
          url: external.url,
          port: external.port,
          status: "running-external",
          log: "",
          startedAt: Date.now(),
        });
        s = status(activeCwd);
      }
    }
    // Renderer-only preview info: useful when this is an Electron
    // project and the user is on a phone (Electron can't run there,
    // but the renderer HTML can be served over the tunnel proxy).
    const rendererInfo = rendererStatus(activeCwd);
    res.json({
      ok: true,
      ...s,
      resolvedFromSession,
      rendererAvailable: rendererAvailable(activeCwd),
      rendererUrl: rendererInfo?.url || null,
      rendererSource: rendererInfo?.source || null,
    });
  });

  app.post("/api/preview/renderer-start", async (req, res) => {
    const cwd = String(req.body?.cwd || "");
    if (!cwd) return res.status(400).json({ ok: false, error: "cwd required" });
    if (!fs.existsSync(cwd)) return res.status(404).json({ ok: false, error: "cwd not found" });
    try {
      const r = await startRenderer(cwd);
      res.json({ ok: true, url: r.url, port: r.port, source: r.source });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post("/api/preview/renderer-stop", (req, res) => {
    const cwd = String(req.body?.cwd || "");
    if (!cwd) return res.status(400).json({ ok: false, error: "cwd required" });
    stopRenderer(cwd);
    res.json({ ok: true });
  });

  app.post("/api/preview/dev-start", async (req, res) => {
    const cwd = String(req.body?.cwd || "");
    if (!cwd) return res.status(400).json({ ok: false, error: "cwd required" });
    if (!fs.existsSync(cwd)) return res.status(404).json({ ok: false, error: "cwd not found" });
    try {
      const entry = await startAndWait(cwd);
      res.json({
        ok: true,
        kind: entry.kind || "npm",
        url: entry.url,
        port: entry.port,
        script: entry.script,
        logTail: entry.log ? entry.log.split("\n").slice(-12).join("\n") : null,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post("/api/preview/dev-stop", (req, res) => {
    const cwd = String(req.body?.cwd || "");
    if (!cwd) return res.status(400).json({ ok: false, error: "cwd required" });
    stop(cwd);
    res.json({ ok: true });
  });

  // Clean shutdown on daemon exit — don't leave orphaned dev servers
  // hogging ports after Veronum Bridge quits.
  process.on("SIGINT", stopAll);
  process.on("SIGTERM", stopAll);
  process.on("beforeExit", stopAll);
}

module.exports = { mountDevServer, startAndWait, status, stop, stopAll };
