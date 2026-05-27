/**
 * Veronum Bridge — Electron menu-bar wrapper around the chat-localhost
 * Express server.
 *
 * Why Electron at all (vs. a pure Node binary)?
 *   1. Mac code-signing + notarization for free via electron-builder.
 *   2. A real .app with a menu-bar Tray icon so the user can pair /
 *      unpair / pause / quit without a terminal.
 *   3. The same DMG cert + entitlements + auto-update pipeline used
 *      by veronum-overlay.
 *
 * Architecture: this main process synchronously requires server.js,
 * which triggers app.listen(3001) inside it. The Electron process
 * becomes the Node host for the Express app. No BrowserWindow is
 * created — the UI is the user's external browser hitting
 * thetoolswebsite.com (which redirects to the local tunnel) or
 * http://localhost:3001 directly.
 *
 * Pair UX flow (v0.3.2+):
 *   1. On first launch, server boots → bridgeSupabase.init() polls
 *      /functions/v1/veronum-bridge/status → state goes "unpaired".
 *   2. This file polls http://localhost:3001/api/bridge/state every
 *      3s. When state = "unpaired" AND we haven't auto-paired yet,
 *      we POST /api/bridge/begin-pair → get pair_url → open it in
 *      the default browser.
 *   3. User signs in (or signs up) on /pair-bridge?code=XXX → page
 *      POSTs /complete-pair → bridge row gets user_id.
 *   4. Daemon's next /status poll sees user_id set → connects to
 *      Realtime channel → state goes "connected".
 *   5. Menu bar updates from "Pair this Mac" → "✓ Paired".
 */

const { app, Tray, Menu, shell, nativeImage, Notification } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

// ─── Single-instance lock ────────────────────────────────────────────────
// Double-launching would spawn a second Node trying to bind :3001 → crash.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  return;
}

// Hide the Dock icon — this is a menu-bar-only app.
app.dock?.hide();

const PORT = parseInt(process.env.PORT || "3001", 10);
const BRIDGE_API_BASE = `http://localhost:${PORT}`;

let tray = null;
let serverModule = null;
let serverStartedAt = null;
let lastError = null;

// Mirror of /api/bridge/state — re-polled every 3s.
let bridgeState = {
  state: "uninit",
  detail: null,
  installId: null,
  userId: null,
  pairCode: null,
  pairUrl: null,
};

// True once we've kicked off the auto-pair flow this app launch.
// Prevents us from opening the browser repeatedly while the user is
// signing in. Reset only if pairing fails OR the user explicitly
// clicks "Pair this Mac" again.
let autoPairTriggered = false;

function trayIconPath() {
  const candidate = path.join(__dirname, "tray-iconTemplate.png");
  if (fs.existsSync(candidate)) return candidate;
  return path.join(__dirname, "..", "build", "icon.png");
}

function buildTrayImage() {
  const img = nativeImage.createFromPath(trayIconPath());
  return img.isEmpty()
    ? nativeImage.createEmpty()
    : img.resize({ width: 18, height: 18 });
}

function startServer() {
  try {
    serverModule = require(path.join(__dirname, "..", "server.js"));
    serverStartedAt = Date.now();
    lastError = null;
    console.log("[bridge] server started");
  } catch (e) {
    lastError = e;
    console.error("[bridge] server failed to start:", e);
    showError(`Bridge failed to start: ${e.message}`);
  }
}

function showError(msg) {
  try {
    new Notification({ title: "Veronum Bridge", body: msg }).show();
  } catch {}
}

function notify(title, body) {
  try {
    new Notification({ title, body }).show();
  } catch {}
}

// ─── Pair flow ────────────────────────────────────────────────────────────
// Wraps POST /api/bridge/begin-pair and openExternal on the returned URL.
async function beginPairFlow() {
  if (!serverStartedAt) return;
  try {
    const res = await fetch(`${BRIDGE_API_BASE}/api/bridge/begin-pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.pair_url) {
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    console.log(`[bridge] opening pair URL: ${body.pair_url}`);
    shell.openExternal(body.pair_url);
    notify(
      "Veronum Bridge",
      "We opened the pairing page in your browser. Sign in there to finish pairing.",
    );
  } catch (e) {
    console.warn(`[bridge] beginPairFlow failed: ${e.message}`);
    showError(`Couldn't start pairing: ${e.message}`);
    autoPairTriggered = false; // allow another attempt
  }
}

// Triggered on every state poll. We only auto-open the browser ONCE per
// app launch, and only when we've actually seen the "unpaired" state
// from the daemon (so we don't blast the browser open during the boot
// "uninit" phase before bridgeSupabase has even contacted the edge fn).
async function maybeAutoPair() {
  if (autoPairTriggered) return;
  if (bridgeState.state !== "unpaired") return;
  // Skip auto-pair if we're STILL in the boot sub-phase where detail
  // contains "checking pair state" — wait one more tick to be sure.
  if ((bridgeState.detail || "").includes("checking")) return;
  autoPairTriggered = true;
  console.log("[bridge] first-launch unpaired — auto-opening pair page");
  await beginPairFlow();
}

async function unpairFlow() {
  try {
    await fetch(`${BRIDGE_API_BASE}/api/bridge/unpair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    autoPairTriggered = false; // they can re-pair from a clean state
    notify("Veronum Bridge", "This Mac is no longer paired.");
  } catch (e) {
    showError(`Couldn't unpair: ${e.message}`);
  }
}

// ─── State polling ────────────────────────────────────────────────────────
async function pollBridgeState() {
  if (!serverStartedAt) return;
  try {
    const res = await fetch(`${BRIDGE_API_BASE}/api/bridge/state`);
    if (!res.ok) return;
    const body = await res.json();
    bridgeState = body || bridgeState;
    rebuildMenu();
    maybeAutoPair();
  } catch {
    // Server probably restarting — leave last-known state in place.
  }
}

// ─── Menu rendering ───────────────────────────────────────────────────────
function statusLabel() {
  if (!serverStartedAt) {
    if (lastError) return `⚠ Server stopped (${lastError.message.slice(0, 40)})`;
    return "Starting…";
  }
  switch (bridgeState.state) {
    case "connected":
      return `✓ Paired — Mac online`;
    case "pairing":
      return bridgeState.pairCode
        ? `Pairing — code ${bridgeState.pairCode}`
        : "Pairing…";
    case "unpaired":
      return "Not paired";
    case "error":
      return `⚠ Bridge error (${(bridgeState.detail || "").slice(0, 40)})`;
    default:
      return `● Running on localhost:${PORT}`;
  }
}

function rebuildMenu() {
  if (!tray) return;
  const paired = bridgeState.state === "connected";
  const pairing = bridgeState.state === "pairing";
  const unpaired = bridgeState.state === "unpaired" || bridgeState.state === "error";

  const items = [
    { label: statusLabel(), enabled: false },
  ];

  // Pair / unpair section
  if (paired) {
    items.push({ type: "separator" });
    items.push({
      label: "Unpair this Mac",
      click: () => unpairFlow(),
    });
  } else if (unpaired) {
    items.push({ type: "separator" });
    items.push({
      label: "Pair this Mac",
      enabled: !!serverStartedAt,
      click: () => {
        autoPairTriggered = false; // explicit retry resets the flag
        beginPairFlow();
      },
    });
  } else if (pairing) {
    items.push({ type: "separator" });
    items.push({
      label: "Re-open pairing page",
      enabled: !!serverStartedAt && !!bridgeState.pairUrl,
      click: () => {
        if (bridgeState.pairUrl) shell.openExternal(bridgeState.pairUrl);
      },
    });
  }

  // Open chat — always visible when server is up.
  items.push({ type: "separator" });
  items.push({
    label: "Open chat (web)",
    enabled: !!serverStartedAt,
    click: () => shell.openExternal("https://www.thetoolswebsite.com/chat"),
  });
  items.push({
    label: "Open chat (localhost)",
    enabled: !!serverStartedAt,
    click: () => shell.openExternal(`http://localhost:${PORT}/`),
  });

  // Maintenance
  items.push({ type: "separator" });
  items.push({
    label: "Restart bridge",
    enabled: !!serverStartedAt,
    click: () => {
      app.relaunch();
      app.quit();
    },
  });
  items.push({ type: "separator" });
  items.push({
    label: "About Veronum Bridge",
    click: () => shell.openExternal("https://github.com/DylanWain/veronum-bridge"),
  });
  items.push({ label: "Quit Veronum Bridge", click: () => app.quit() });

  tray.setContextMenu(Menu.buildFromTemplate(items));
  tray.setToolTip(`Veronum Bridge — ${statusLabel()}`);
}

// ─── Lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  tray = new Tray(buildTrayImage());
  rebuildMenu();
  startServer();
  rebuildMenu();
  // Poll state every 3s so the menu reflects current pair state and the
  // auto-pair-on-first-launch fires within ~3s of the daemon discovering
  // it's unpaired (which takes ~1s after startServer).
  setInterval(pollBridgeState, 3000);
});

app.on("window-all-closed", (e) => {
  e.preventDefault();
});

app.on("before-quit", () => {
  try {
    serverModule?.shutdown?.();
  } catch {}
});
