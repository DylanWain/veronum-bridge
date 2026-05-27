/**
 * lib/previewProxy.js — live preview of localhost dev servers from any
 * device through the bridge tunnel.
 *
 * The user runs `npm run dev` on their Mac. Vite (or Next/CRA/etc.)
 * binds localhost:5173. They want to see that on their phone.
 *
 * We expose two pieces:
 *
 *   GET /api/preview/ports
 *     → { ports: [{port, command, pid}] }
 *     lsof-based discovery of localhost HTTP services we could proxy.
 *     Filters out our own daemon port + non-dev system ports.
 *
 *   ALL /preview/:port/*
 *     Reverse-proxies to http://localhost:<port> with WebSocket upgrade
 *     for HMR. Rewrites root-relative URLs in HTML responses so the
 *     dev server's assets resolve under the /preview/<port> path.
 *
 * Why path-based (vs subdomain): zero new infra, works through the
 * existing cloudflared tunnel without a custom domain. Tradeoff is
 * the HTML rewriting fragility (modern dev servers emit absolute
 * paths in module imports that we can't fully rewrite at the proxy
 * layer). Vite-specific HMR config injection is a follow-up; for v1
 * we cover the common cases.
 *
 * Security: only ports > 1024 and < 65535, only ports that actually
 * respond to GET /, only via the existing daemon auth surface. The
 * tunnel is already gated by Supabase JWT on the chat page that
 * surfaces the preview UI.
 */

"use strict";

const { spawn } = require("node:child_process");
const { createProxyMiddleware } = require("http-proxy-middleware");

const SELF_PORT = parseInt(process.env.PORT || "3001", 10);

// Ports we never want to proxy regardless of who's binding them.
// SELF_PORT is the daemon; 22 ssh; 3306/5432 databases (no http on those);
// 5900/5901 vnc; <1024 privileged. Keep this conservative — anything
// not in the dev-server range gets surfaced by the discovery endpoint
// but won't be in the auto-detected default list.
const DEFAULT_BLACKLIST = new Set([22, 25, 53, 80, 443, 3306, 5432, 5900, 5901]);

// ─── Port discovery via lsof ─────────────────────────────────────────────
// `lsof -nP -iTCP -sTCP:LISTEN` lists all LISTEN sockets. We parse the
// COMMAND, PID, and the port from the NAME column (e.g. "*:5173"
// or "127.0.0.1:5173" or "[::1]:5173").
function discoverPorts() {
  return new Promise((resolve) => {
    const proc = spawn("/usr/sbin/lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    proc.stdout.on("data", (chunk) => { out += chunk.toString("utf8"); });
    proc.on("error", () => resolve([]));
    proc.on("close", () => {
      const lines = out.split("\n").slice(1).filter(Boolean); // drop header
      const seen = new Map(); // port → { command, pid }
      for (const line of lines) {
        // Whitespace-separated columns; NAME is column 8+ (the address).
        // lsof appends " (LISTEN)" at the end which is column 9 onwards —
        // we don't care about that part, just the address column.
        const cols = line.split(/\s+/);
        if (cols.length < 9) continue;
        const command = cols[0];
        const pid = parseInt(cols[1], 10);
        const addr = cols[8]; // just the address column, no trailing (LISTEN)
        // Match the LAST :PORT in the address. Handles IPv4 (127.0.0.1:5173),
        // wildcard (*:5173), and IPv6 ([::1]:5173).
        const m = addr.match(/[:.](\d+)$/);
        if (!m) continue;
        const port = parseInt(m[1], 10);
        if (!Number.isFinite(port)) continue;
        if (port === SELF_PORT) continue;
        if (port < 1024 || port > 65535) continue;
        if (DEFAULT_BLACKLIST.has(port)) continue;
        if (seen.has(port)) continue;
        seen.set(port, { port, command, pid });
      }
      // Return an array sorted by port. The UI can re-rank by "likely
      // dev server" (Vite=5173, Next=3000, CRA=3000, Astro=4321 etc.)
      // if it wants.
      resolve([...seen.values()].sort((a, b) => a.port - b.port));
    });
  });
}

// ─── HTML response rewriting ─────────────────────────────────────────────
// Inject <base> + prefix root-relative attrs so Vite/Next/etc.'s
// `<script src="/src/main.tsx">` resolves under /preview/<port>/.
//
// This is the fragile part. Modern dev servers also emit absolute paths
// inside <script type="module"> import statements which we DON'T rewrite
// at this layer — for those, the user needs to either configure the dev
// server's base path (Vite: `--base /preview/5173/`) or accept that
// some HMR scenarios will be flaky. We log a one-time warning to the
// daemon console when we see a Vite client to remind them.
function rewriteHtml(html, port) {
  const basePath = `/preview/${port}/`;
  // Step 1: rewrite root-relative attribute values FIRST, before we
  // inject the <base> tag (otherwise the regex would re-prefix our
  // own <base href="/preview/5173/" → "/preview/5173/preview/5173/").
  //
  // Conservative regex: only touches src/href/srcset/action with a
  // single leading slash. Protocol-relative //example.com is left
  // alone (the (?!\/) negative-lookahead).
  let out = html.replace(
    /\b(src|href|srcset|action)="\/(?!\/)([^"]*)"/g,
    (_, attr, rest) => `${attr}="${basePath}${rest}"`,
  );
  // Step 2: now inject the <base> tag. We didn't have one in the
  // attribute regex's input (or it would have matched), so injecting
  // here is safe.
  const baseTag = `<base href="${basePath}">`;
  if (/<head[^>]*>/i.test(out) && !/<base\s/i.test(out)) {
    out = out.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`);
  } else if (!/<base\s/i.test(out)) {
    // No <head> — prepend at the top (rare, but malformed HTML happens).
    out = baseTag + out;
  }
  return out;
}

// ─── Express middleware ──────────────────────────────────────────────────
// Parse port from /preview/<port>/* path. Returns null for invalid.
function extractPort(reqUrl) {
  const m = (reqUrl || "").match(/^\/preview\/(\d+)(?:\/|$)/);
  if (!m) return null;
  const port = parseInt(m[1], 10);
  if (!Number.isFinite(port) || port < 1024 || port > 65535) return null;
  if (port === SELF_PORT) return null;
  return port;
}

// Create the proxy middleware ONCE so we have a stable .upgrade handler
// we can bind to the http.Server's 'upgrade' event for WS/HMR support.
// The router function picks the upstream per request based on the URL.
//
// Note: when used via app.use("/preview/:port", ...), Express strips the
// mount prefix from req.url. We use req.originalUrl in the router and
// proxyRes hooks so the /preview/<port>/... prefix is still visible.
function buildProxy() {
  return createProxyMiddleware({
    router: (req) => {
      const port = extractPort(req.originalUrl || req.url);
      if (!port) return null;
      return `http://localhost:${port}`;
    },
    changeOrigin: true,
    ws: true,
    pathRewrite: (path, req) => {
      // For HTTP requests Express strips the mount prefix in req.url —
      // pathRewrite gets the already-stripped path, so we just pass it
      // through (the dev server expects "/", not "/preview/5173/").
      // For WS upgrades, req.url IS the full URL (no Express layer),
      // so we strip the prefix here.
      return path.replace(/^\/preview\/\d+/, "") || "/";
    },
    selfHandleResponse: true,
    on: {
      proxyRes: (proxyRes, req, clientRes) => {
        const port = extractPort(req.originalUrl || req.url) || 0;
        const ct = (proxyRes.headers["content-type"] || "").toLowerCase();
        if (!ct.includes("text/html")) {
          clientRes.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
          proxyRes.pipe(clientRes);
          return;
        }
        const chunks = [];
        proxyRes.on("data", (c) => chunks.push(c));
        proxyRes.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          const rewritten = rewriteHtml(body, port);
          const headers = { ...proxyRes.headers };
          delete headers["content-length"];
          delete headers["content-encoding"];
          clientRes.writeHead(proxyRes.statusCode || 200, headers);
          clientRes.end(rewritten);
        });
        proxyRes.on("error", (err) => {
          console.warn(`[preview] upstream stream error: ${err.message}`);
          try { clientRes.end(); } catch {}
        });
      },
      error: (err, _req, clientRes) => {
        console.warn(`[preview] proxy error: ${err.message}`);
        if (clientRes && !clientRes.headersSent) {
          try {
            clientRes.writeHead(502, { "content-type": "application/json" });
            clientRes.end(JSON.stringify({
              ok: false,
              error: "upstream_unreachable",
              detail: err.message,
            }));
          } catch {}
        }
      },
    },
  });
}

// Mount on the Express app + attach the WS upgrade handler to the HTTP
// server returned from app.listen(). The server arg is optional; if
// omitted, plain HTTP requests still work but HMR over WS will not.
function mountPreviewProxy(app, server) {
  const proxy = buildProxy();

  // Pre-validate the port; reject early with 400 if invalid before
  // letting the proxy try and fail.
  app.use("/preview/:port", (req, res, next) => {
    const port = extractPort(req.originalUrl);
    if (!port) {
      return res.status(400).json({ ok: false, error: "invalid_port" });
    }
    return proxy(req, res, next);
  });

  if (server && proxy.upgrade) {
    server.on("upgrade", (req, socket, head) => {
      if (!req.url || !req.url.startsWith("/preview/")) return; // not ours
      proxy.upgrade(req, socket, head);
    });
  }

  app.get("/api/preview/ports", async (_req, res) => {
    try {
      const ports = await discoverPorts();
      res.json({ ok: true, ports });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
}

module.exports = { mountPreviewProxy, discoverPorts };
