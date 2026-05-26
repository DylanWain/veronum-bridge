/**
 * Veronum Bridge — Electron menu-bar wrapper around the chat-localhost
 * Express server.
 *
 * Why Electron at all (vs. a pure Node binary)?
 *   1. We get Mac code-signing + notarization for free via electron-
 *      builder + scripts/notarize-afterSign.js (already battle-tested
 *      in veronum-overlay).
 *   2. We get a real .app bundle with a menu-bar Tray icon, which lets
 *      the user pause/quit/open the chat without keeping a terminal
 *      window open. Pure `pkg`-bundled binaries can't draw native UI.
 *   3. We can ship the same DMG cert + entitlements + auto-update
 *      pipeline veronum-overlay uses, instead of reinventing it.
 *
 * Architecture: this main process loads server.js synchronously, which
 * triggers app.listen(3001) inside it. The Electron process becomes the
 * Node host for the Express app. No `BrowserWindow` is created — the
 * UI is the user's external browser (Chrome/Safari) hitting
 * http://localhost:3001 or, in the cloud-relay phase, chat.thetoolswebsite.com.
 */

const { app, Tray, Menu, shell, nativeImage, Notification } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

// ─── Single-instance lock ─────────────────────────────────────────
// Without this, double-clicking the .app while it's already running
// would spawn a second Node process trying to bind :3001 — second
// instance crashes with EADDRINUSE and the user just sees nothing.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  return;
}

// Hide the Dock icon — this is a menu-bar-only app. The Dock would
// suggest there's a window to switch to, which there isn't.
app.dock?.hide();

let tray = null;
let serverModule = null;
let serverStartedAt = null;
let lastError = null;

function trayIconPath() {
  // For dev runs (`npm run electron:dev`), __dirname is .../electron/.
  // For packaged builds, files inside asar are read via electron's
  // virtual FS the same way. We ship a template icon (white outline on
  // transparent) so macOS auto-inverts it for dark/light menu bar.
  const candidate = path.join(__dirname, "tray-iconTemplate.png");
  if (fs.existsSync(candidate)) return candidate;
  // Fallback to the bundle's main icon if the tray template is missing.
  return path.join(__dirname, "..", "build", "icon.png");
}

function buildTrayImage() {
  const img = nativeImage.createFromPath(trayIconPath());
  // Resize to 18x18 (standard menu-bar size on Retina, auto-scales).
  return img.isEmpty()
    ? nativeImage.createEmpty()
    : img.resize({ width: 18, height: 18 });
}

function startServer() {
  try {
    // Requiring server.js runs its app.listen() side effect. We hold the
    // module handle so the GC doesn't tear it down.
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
  // Non-blocking notification so the user actually sees errors even
  // when there's no main window.
  try {
    new Notification({ title: "Veronum Bridge", body: msg }).show();
  } catch {}
}

function rebuildMenu() {
  const items = [
    {
      label: serverStartedAt
        ? `● Running on localhost:3001`
        : lastError
        ? `⚠ Server stopped (${lastError.message.slice(0, 40)})`
        : "Starting…",
      enabled: false,
    },
    { type: "separator" },
    {
      label: "Open chat (localhost:3001)",
      enabled: !!serverStartedAt,
      click: () => shell.openExternal("http://localhost:3001/"),
    },
    {
      label: "Open chat (cloud)",
      enabled: !!serverStartedAt,
      // For the MVP, the cloud relay isn't deployed yet, so this opens
      // the marketing site. Once chat.thetoolswebsite.com is live this
      // becomes the primary entry point.
      click: () => shell.openExternal("https://www.thetoolswebsite.com/"),
    },
    { type: "separator" },
    {
      label: "Pause bridge",
      enabled: !!serverStartedAt,
      // We don't actually have a clean shutdown handle on the Express
      // server today — restart is the same operation. Pause = quit
      // tray icon and re-launch on demand. MVP simplification.
      click: () => {
        app.relaunch();
        app.quit();
      },
    },
    { type: "separator" },
    {
      label: "About Veronum Bridge",
      click: () => shell.openExternal("https://github.com/DylanWain/veronum-bridge"),
    },
    { label: "Quit Veronum Bridge", click: () => app.quit() },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(items));
  tray.setToolTip(
    serverStartedAt
      ? "Veronum Bridge — running"
      : lastError
      ? `Veronum Bridge — error: ${lastError.message}`
      : "Veronum Bridge — starting",
  );
}

app.whenReady().then(() => {
  tray = new Tray(buildTrayImage());
  rebuildMenu();
  startServer();
  rebuildMenu();
  // Re-render the menu every 5s so the "started ago" label and any
  // late-arriving errors surface without user action.
  setInterval(rebuildMenu, 5000);
});

// Keep the app alive even with no windows — that's the point of a
// menu-bar app.
app.on("window-all-closed", (e) => {
  e.preventDefault();
});

// Cleanly shut down the Express server on quit.
app.on("before-quit", () => {
  try {
    serverModule?.shutdown?.();
  } catch {}
});
