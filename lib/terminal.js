/**
 * lib/terminal.js — in-browser terminal for the Files panel.
 *
 * Spawns a real zsh per WebSocket connection via node-pty, rooted at
 * the session's cwd. Streams stdout back to xterm.js on the client;
 * accepts stdin + resize events the same way. Multiple terminals per
 * session are independent connections.
 *
 * WS path:  /api/terminal/stream?cwd=<path>&cols=80&rows=24
 *
 * Wire protocol (JSON messages both directions):
 *   server → client  { type: "data", data: "<bytes as utf8>" }
 *   server → client  { type: "exit", code, signal }
 *   server → client  { type: "error", message }
 *   client → server  { type: "input", data: "<bytes>" }
 *   client → server  { type: "resize", cols, rows }
 *
 * Security: cwd is validated to exist on disk; no path sandboxing
 * because the daemon already runs as the user and the terminal IS
 * giving you a shell — there's nothing to constrain that the shell
 * itself wouldn't let you do via `cd`.
 */

"use strict";

const pty = require("node-pty");
const fs = require("node:fs");
const { WebSocketServer } = require("ws");

// macOS default. Falls back to whatever SHELL the daemon was launched
// with, then to /bin/zsh if all else fails. VS Code does the same.
const DEFAULT_SHELL = process.env.SHELL || "/bin/zsh";

const sessions = new Map(); // id → { proc, ws, cwd }
let _nextId = 1;

function mountTerminal(app, server) {
  const wss = new WebSocketServer({ noServer: true });

  // Attach to the existing http.Server's upgrade event. Filter by path
  // so we don't collide with the live-preview WS upgrade handler.
  server.on("upgrade", (req, socket, head) => {
    if (!req.url || !req.url.startsWith("/api/terminal/stream")) return;
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws, req) => {
    let url;
    try { url = new URL(req.url, "http://localhost"); }
    catch { ws.close(); return; }

    const cwd = url.searchParams.get("cwd") || process.env.HOME;
    const cols = clampInt(url.searchParams.get("cols"), 20, 400, 80);
    const rows = clampInt(url.searchParams.get("rows"), 5, 200, 24);

    if (!cwd || !fs.existsSync(cwd)) {
      sendSafe(ws, { type: "error", message: `cwd not found: ${cwd}` });
      try { ws.close(); } catch {}
      return;
    }

    let proc;
    try {
      proc = pty.spawn(DEFAULT_SHELL, [], {
        name: "xterm-256color",
        cols, rows, cwd,
        env: {
          ...process.env,
          TERM: "xterm-256color",
          // Mark this shell so the user can detect it from their
          // .zshrc if they want to skip slow prompt plugins, etc.
          VERONUM_TERMINAL: "1",
        },
      });
    } catch (err) {
      sendSafe(ws, { type: "error", message: `pty spawn failed: ${err.message}` });
      try { ws.close(); } catch {}
      return;
    }

    const id = _nextId++;
    sessions.set(id, { proc, ws, cwd });
    console.log(`[terminal] #${id} spawned ${DEFAULT_SHELL} in ${cwd} (pid=${proc.pid})`);

    proc.onData((data) => sendSafe(ws, { type: "data", data }));
    proc.onExit(({ exitCode, signal }) => {
      sendSafe(ws, { type: "exit", code: exitCode, signal });
      try { ws.close(); } catch {}
      sessions.delete(id);
    });

    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); }
      catch { return; }
      if (msg.type === "input" && typeof msg.data === "string") {
        try { proc.write(msg.data); } catch { /* ignore */ }
      } else if (msg.type === "resize") {
        try {
          proc.resize(
            clampInt(msg.cols, 20, 400, 80),
            clampInt(msg.rows, 5, 200, 24),
          );
        } catch { /* ignore */ }
      }
    });

    ws.on("close", () => {
      try { proc.kill(); } catch {}
      sessions.delete(id);
      console.log(`[terminal] #${id} closed`);
    });

    ws.on("error", () => {
      try { proc.kill(); } catch {}
      sessions.delete(id);
    });
  });

  // Cleanly kill all child shells on daemon shutdown — don't orphan zsh
  // procs hanging around after Veronum exits.
  const killAll = () => {
    for (const [id, s] of sessions) {
      try { s.proc.kill(); } catch {}
      try { s.ws.close(); } catch {}
      sessions.delete(id);
    }
  };
  process.on("SIGINT", killAll);
  process.on("SIGTERM", killAll);
  process.on("beforeExit", killAll);
}

function sendSafe(ws, payload) {
  if (ws.readyState !== ws.OPEN) return;
  try { ws.send(JSON.stringify(payload)); }
  catch { /* socket might have closed mid-send */ }
}

function clampInt(raw, min, max, fallback) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

module.exports = { mountTerminal };
