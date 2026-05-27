/**
 * lib/livePreview.js — pixel-streaming "your localhost on your phone".
 *
 * Architecture:
 *   1. Daemon spawns a headless Chrome subprocess pointed at the URL
 *      the user wants to preview (e.g. http://localhost:5173).
 *   2. Connects to Chrome's DevTools Protocol (CDP) via WebSocket.
 *   3. Tells Chrome: Page.startScreencast → Chrome emits JPEG frames
 *      at ~30fps.
 *   4. Daemon pipes those frames over its OWN WebSocket to whatever
 *      client (phone browser, desktop browser, Electron window) is
 *      attached to /api/preview/stream.
 *   5. Client decodes JPEGs into a <canvas>.
 *   6. Touch / mouse / key events from the client come back over the
 *      WS, daemon translates to CDP Input.dispatch* calls.
 *
 * Why headless Chrome (vs proxying HTTP):
 *   - The dev server renders normally on the Mac — no URL rewriting,
 *     no HMR-WebSocket plumbing, no per-framework patches. Vite,
 *     Next, Astro, SvelteKit, CRA, plain HTML all "just work."
 *   - Works identically for an Electron app's renderer (it's a CDP
 *     target too — we can attach to the user's running Electron app
 *     by pointing at chrome://inspect/#devices style targets later).
 *   - Single code path for "view on phone" and "view in desktop tab."
 *
 * Caveats:
 *   - Bandwidth: ~50-150 KB/sec on cellular (similar to a low-quality
 *     video stream). Adjustable via JPEG quality + everyNthFrame.
 *   - Latency: ~150-400ms over a good tunnel; ~500ms over flaky cell.
 *     Fine for "see your page render", noticeable on heavy interaction.
 *   - Each preview spawns one Chrome process (~150 MB RAM). Sessions
 *     are pooled per URL — a 2nd client on the same URL shares the
 *     existing Chrome rather than spawning a new one. Idle timeout
 *     tears Chrome down 60s after the last client disconnects.
 */

"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const WebSocket = require("ws");

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];

function findChromeBinary() {
  if (process.env.VERONUM_CHROME_BIN && fs.existsSync(process.env.VERONUM_CHROME_BIN)) {
    return process.env.VERONUM_CHROME_BIN;
  }
  for (const candidate of CHROME_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

class PreviewSession {
  constructor(url) {
    this.url = url;
    this.chromeProc = null;
    this.cdpWs = null;
    this.targetWsUrl = null;
    this.cdpId = 0;
    this.pendingReplies = new Map();
    this.clients = new Set();
    this.idleTimer = null;
    this.started = false;
    this.starting = null;
  }

  async ensureStarted() {
    if (this.started) return;
    if (this.starting) return this.starting;
    this.starting = this._start().finally(() => { this.starting = null; });
    return this.starting;
  }

  async _start() {
    const chromeBin = findChromeBinary();
    if (!chromeBin) {
      throw new Error("No Chrome/Chromium found on this Mac. Install Google Chrome from google.com/chrome.");
    }
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "veronum-preview-"));
    const args = [
      "--headless=new",
      "--remote-debugging-port=0", // auto-pick a free port
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-popup-blocking",
      "--hide-scrollbars",
      "--window-size=390,844", // iPhone-ish; client can request resize later
      this.url,
    ];
    this.userDataDir = userDataDir;
    this.chromeProc = spawn(chromeBin, args, { stdio: ["ignore", "pipe", "pipe"] });
    this.chromeProc.on("exit", (code, signal) => {
      console.warn(`[preview] chrome exited (code=${code}, signal=${signal}) for ${this.url}`);
      this.started = false;
      // Notify clients so the UI can show a reconnect prompt.
      for (const client of this.clients) {
        try { client.send(JSON.stringify({ type: "ended", reason: "chrome_exited" })); } catch {}
      }
    });

    // Chrome's --headless=new mode no longer writes "DevTools listening
    // on ws://..." to stderr (the old --headless did). Instead it writes
    // a `DevToolsActivePort` file inside the user-data-dir as soon as
    // the debug endpoint is up. The format is two lines:
    //   <port>
    //   /devtools/browser/<uuid>
    const portFile = path.join(userDataDir, "DevToolsActivePort");
    console.log(`[preview] watching for ${portFile}`);
    const browserWsUrl = await new Promise((resolve, reject) => {
      const startedAt = Date.now();
      let attempts = 0;
      const tick = () => {
        attempts++;
        if (this.chromeProc?.exitCode != null) {
          return reject(new Error(`Chrome exited (code=${this.chromeProc.exitCode}) before ready`));
        }
        try {
          if (fs.existsSync(portFile)) {
            const raw = fs.readFileSync(portFile, "utf8");
            console.log(`[preview] found port file after ${attempts} attempts: ${JSON.stringify(raw)}`);
            const lines = raw.trim().split("\n");
            const port = parseInt(lines[0], 10);
            const browserPath = lines[1] || "";
            if (Number.isFinite(port) && browserPath.startsWith("/devtools/browser/")) {
              return resolve(`ws://127.0.0.1:${port}${browserPath}`);
            }
            console.warn(`[preview] port file malformed: port=${port}, path=${browserPath}`);
          }
        } catch (e) {
          console.warn(`[preview] portFile read error: ${e.message}`);
        }
        if (Date.now() - startedAt > 30_000) {
          console.warn(`[preview] timeout after ${attempts} attempts; portFile exists? ${fs.existsSync(portFile)}`);
          return reject(new Error("Chrome DevToolsActivePort timed out after 30s"));
        }
        setTimeout(tick, 100);
      };
      tick();
    });

    // CDP browser endpoint gives us /json — list of targets. Pick the page.
    const httpEndpoint = browserWsUrl
      .replace(/^ws:\/\//, "http://")
      .replace(/\/devtools\/browser\/.*$/, "");
    console.log(`[preview] httpEndpoint=${httpEndpoint}`);
    let pageTarget = null;
    for (let attempt = 0; attempt < 15 && !pageTarget; attempt++) {
      try {
        const targets = await fetch(`${httpEndpoint}/json`).then((r) => r.json());
        console.log(`[preview] /json attempt ${attempt+1} → ${targets.length} targets, types: ${targets.map(t=>t.type).join(',')}`);
        pageTarget = targets.find((t) => t.type === "page");
        if (!pageTarget) await new Promise((r) => setTimeout(r, 300));
      } catch (e) {
        console.warn(`[preview] /json fetch error: ${e.message}`);
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    if (!pageTarget) throw new Error("Chrome opened but no page target available");
    this.targetWsUrl = pageTarget.webSocketDebuggerUrl;
    console.log(`[preview] page target: ${this.targetWsUrl}`);

    // Connect to the page's CDP socket.
    this.cdpWs = new WebSocket(this.targetWsUrl);
    await new Promise((resolve, reject) => {
      this.cdpWs.once("open", () => { console.log(`[preview] CDP page WS open`); resolve(); });
      this.cdpWs.once("error", (e) => { console.warn(`[preview] CDP page WS error: ${e.message}`); reject(e); });
    });

    this.cdpWs.on("message", (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.id && this.pendingReplies.has(msg.id)) {
        const cb = this.pendingReplies.get(msg.id);
        this.pendingReplies.delete(msg.id);
        cb(msg);
        return;
      }
      if (msg.method === "Page.screencastFrame") {
        const frame = msg.params.data;
        const sessionId = msg.params.sessionId;
        const metadata = msg.params.metadata || {};
        this._frameCount = (this._frameCount || 0) + 1;
        if (this._frameCount === 1 || this._frameCount % 30 === 0) {
          console.log(`[preview] frame #${this._frameCount} (${frame.length} b64 chars) → ${this.clients.size} client(s)`);
        }
        for (const client of this.clients) {
          try {
            client.send(JSON.stringify({ type: "frame", data: frame, metadata }));
          } catch {}
        }
        // CRITICAL: Chrome only sends the NEXT frame after we ack the
        // previous one. Without the ack, the stream stalls after one
        // frame (or sometimes zero if startScreencast fired before our
        // ack handler attached).
        this._sendCdp("Page.screencastFrameAck", { sessionId }).catch(() => {});
      }
    });

    await this._sendCdp("Page.enable");
    await this._sendCdp("Runtime.enable");
    console.log(`[preview] Page+Runtime enabled, navigating to ${this.url}`);
    // In --headless=new, the screencast won't paint until we give the
    // renderer a real viewport. The --window-size CLI flag doesn't
    // actually reach the new headless renderer (only the old one).
    await this._sendCdp("Emulation.setDeviceMetricsOverride", {
      width: 800,
      height: 1280,
      deviceScaleFactor: 1,
      mobile: false,
    }).catch((e) => console.warn(`[preview] setDeviceMetricsOverride failed: ${e.message}`));
    // Explicit Page.navigate to the URL. The Chrome cmd-line URL argument
    // sometimes gets swallowed in --headless=new mode (or opens in a
    // separate target we never attached to). Navigating directly via
    // CDP guarantees the attached target loads the right page.
    try {
      await this._sendCdp("Page.navigate", { url: this.url });
      console.log(`[preview] Page.navigate sent`);
    } catch (e) {
      console.warn(`[preview] Page.navigate failed: ${e.message}`);
    }
    // Give the page a tick to start loading. Without this, startScreencast
    // sometimes attaches before the renderer has a frame to capture.
    await new Promise((r) => setTimeout(r, 500));

    // Skip Page.startScreencast — it only emits frames on repaints,
    // so a static page (most dev sites at rest) produces ONE frame
    // and then silence. Instead we poll Page.captureScreenshot at a
    // steady cadence. Slightly less efficient when the page is busy
    // animating, but guarantees the user always sees the current
    // state of the page (and any updates) within ~100ms.
    this.started = true;
    console.log(`[preview] streaming ${this.url} via captureScreenshot polling (Chrome pid=${this.chromeProc.pid})`);
    this._startScreenshotLoop();
  }

  async _startScreenshotLoop() {
    const INTERVAL_MS = 150; // ~6-7 fps; quality vs bandwidth tradeoff
    while (this.started) {
      // Stop the loop when no clients are attached. Saves Chrome CPU
      // when the panel is closed. Loop resumes next attachClient.
      if (this.clients.size === 0) {
        await new Promise((r) => setTimeout(r, INTERVAL_MS));
        continue;
      }
      const t0 = Date.now();
      try {
        const shot = await this._sendCdp("Page.captureScreenshot", {
          format: "jpeg",
          quality: 60,
        });
        if (shot?.data) {
          this._frameCount = (this._frameCount || 0) + 1;
          if (this._frameCount === 1 || this._frameCount % 60 === 0) {
            console.log(`[preview] frame #${this._frameCount} (${shot.data.length} b64 chars) → ${this.clients.size} client(s)`);
          }
          const msg = JSON.stringify({ type: "frame", data: shot.data });
          for (const client of this.clients) {
            try { client.send(msg); } catch {}
          }
        }
      } catch (e) {
        // CDP can flake mid-stream; log occasionally but don't bail.
        if ((this._frameCount || 0) % 60 === 0) {
          console.warn(`[preview] captureScreenshot error: ${e.message}`);
        }
      }
      // Pace to roughly INTERVAL_MS regardless of how long capture took.
      const dt = Date.now() - t0;
      if (dt < INTERVAL_MS) {
        await new Promise((r) => setTimeout(r, INTERVAL_MS - dt));
      }
    }
  }

  _sendCdp(method, params = {}) {
    const id = ++this.cdpId;
    return new Promise((resolve, reject) => {
      this.pendingReplies.set(id, (msg) => {
        if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
        else resolve(msg.result);
      });
      try {
        this.cdpWs.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        this.pendingReplies.delete(id);
        reject(e);
      }
    });
  }

  // Translate client-side input events into CDP Input.* calls.
  async dispatchInput(event) {
    if (!this.started) return;
    try {
      switch (event.type) {
        case "mousePressed":
        case "mouseReleased":
        case "mouseMoved":
          await this._sendCdp("Input.dispatchMouseEvent", {
            type: event.type,
            x: Math.round(event.x),
            y: Math.round(event.y),
            button: event.button || "left",
            clickCount: event.clickCount || 1,
          });
          break;
        case "mouseWheel":
          await this._sendCdp("Input.dispatchMouseEvent", {
            type: "mouseWheel",
            x: Math.round(event.x),
            y: Math.round(event.y),
            deltaX: event.deltaX || 0,
            deltaY: event.deltaY || 0,
          });
          break;
        case "keyDown":
        case "keyUp":
        case "char":
          await this._sendCdp("Input.dispatchKeyEvent", {
            type: event.type,
            key: event.key,
            code: event.code,
            text: event.text,
            modifiers: event.modifiers || 0,
          });
          break;
        case "navigate":
          await this._sendCdp("Page.navigate", { url: event.url });
          break;
        case "reload":
          await this._sendCdp("Page.reload");
          break;
        case "resize":
          // Re-launch screencast with new dimensions. CDP doesn't let
          // you resize mid-stream — stop + restart.
          await this._sendCdp("Page.stopScreencast");
          await this._sendCdp("Page.startScreencast", {
            format: "jpeg",
            quality: 70,
            maxWidth: event.width || 800,
            maxHeight: event.height || 1600,
            everyNthFrame: 2,
          });
          break;
      }
    } catch (e) {
      console.warn(`[preview] dispatchInput(${event.type}) failed:`, e.message);
    }
  }

  attachClient(ws) {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.clients.add(ws);
    ws.send(JSON.stringify({ type: "ready", url: this.url, started: this.started }));
    ws.on("close", () => {
      this.clients.delete(ws);
      if (this.clients.size === 0) {
        this.idleTimer = setTimeout(() => this.stop(), 60_000);
      }
    });
  }

  stop() {
    console.log(`[preview] stopping session for ${this.url}`);
    try { this.cdpWs?.close(); } catch {}
    try { this.chromeProc?.kill("SIGTERM"); } catch {}
    if (this.userDataDir) {
      // Best-effort cleanup so /tmp doesn't fill up.
      setTimeout(() => {
        try { fs.rmSync(this.userDataDir, { recursive: true, force: true }); } catch {}
      }, 5000);
    }
    sessions.delete(this.url);
  }
}

// One session per URL. Subsequent clients share the existing Chrome.
const sessions = new Map();

function getOrCreateSession(url) {
  let s = sessions.get(url);
  if (s) return s;
  s = new PreviewSession(url);
  sessions.set(url, s);
  return s;
}

// HTTP route registrar + WS upgrade installer. Pass the http.Server
// returned from app.listen() so we can hook 'upgrade'.
function mountLivePreview(app, server) {
  const wss = new WebSocket.Server({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    if (!req.url || !req.url.startsWith("/api/preview/stream")) return;
    const reqUrl = new URL(req.url, "http://localhost");
    const target = reqUrl.searchParams.get("url");
    if (!target || !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(target)) {
      // Refuse to proxy anything other than localhost — this is a
      // remote-control surface for the user's OWN dev server, not a
      // way to browse the public internet from inside the daemon.
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\nbad url\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, async (ws) => {
      const session = getOrCreateSession(target);
      session.attachClient(ws);
      try {
        await session.ensureStarted();
      } catch (e) {
        try {
          ws.send(JSON.stringify({ type: "error", message: e.message }));
        } catch {}
      }
      ws.on("message", (data) => {
        let event;
        try { event = JSON.parse(data.toString()); } catch { return; }
        session.dispatchInput(event).catch(() => {});
      });
    });
  });

  app.get("/api/preview/diagnose", (_req, res) => {
    res.json({
      ok: true,
      chromeBin: findChromeBinary(),
      activeSessions: [...sessions.keys()],
    });
  });
}

module.exports = { mountLivePreview, findChromeBinary };
