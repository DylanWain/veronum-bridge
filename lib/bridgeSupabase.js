/**
 * lib/bridgeSupabase.js — Veronum Bridge daemon's cloud-relay client.
 *
 * Connects the daemon to its Supabase Realtime broadcast channel so a
 * signed-in user at chat.thetoolswebsite.com can send dispatch requests
 * to THIS Mac from any device.
 *
 * State machine:
 *
 *   ┌──────────────┐ first-launch ┌──────────┐
 *   │  no install  │─────────────▶│ unpaired │
 *   │  id on disk  │              │          │
 *   └──────────────┘              └────┬─────┘
 *                                      │ user clicks "Pair this Mac"
 *                                      ▼
 *                                 ┌──────────┐ poll /status
 *                                 │ pairing  │──┐
 *                                 │          │  │
 *                                 └────┬─────┘◀─┘
 *                                      │ /status returns paired=true
 *                                      ▼
 *                                 ┌──────────────┐
 *                                 │  connected   │ ← subscribed to
 *                                 │              │   bridge:<install_id>
 *                                 └──────────────┘   Realtime channel
 *
 * Public API (called from server.js + electron/main.js):
 *
 *   init({ onState, onDispatch })   — kick off the state machine. Returns
 *                                      a `state()` getter + control fns.
 *   getInstallId()                  — read the persisted UUID
 *   beginPair()                     — call /begin-pair, return pair_url
 *   forceUnpair()                   — clear pairing on this device
 *   sendOutbound(channel, payload)  — publish a broadcast event to the
 *                                      paired channel (deltas, results)
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const { createClient } = require("@supabase/supabase-js");

// ─── Constants — match Tools-AI exactly ────────────────────────────────────
// Same Supabase project the marketing site + overlay app use. Anon key is
// publishable (RLS gates every table); embedding it in a shipped Mac app
// is safe per Supabase's own guidance.
const SUPABASE_URL = "https://synpjcammfjebwsmtfpz.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_1h3d9dMB7f5JK_8aLHR5ig_GiurDzuS";
const EDGE_FN_BASE = `${SUPABASE_URL}/functions/v1/veronum-bridge`;

// Where the install_id lives on disk. Mac: ~/Library/Application Support;
// Linux/Windows: ~/.config (so the same code works for future ports).
function installFilePath() {
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "Veronum Bridge",
      "install.json",
    );
  }
  return path.join(os.homedir(), ".config", "veronum-bridge", "install.json");
}

// Read-or-create the install record. Returns { install_id, created_at }.
// install_id is a UUIDv4 that uniquely identifies THIS Mac install. It
// survives app updates (file is outside the .app bundle) but a user who
// deletes the file gets a fresh identity — that's intentional, lets
// people start over by deleting Application Support/Veronum Bridge.
function loadOrCreateInstall() {
  const p = installFilePath();
  try {
    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed?.install_id && typeof parsed.install_id === "string") {
      return parsed;
    }
  } catch { /* missing or malformed — fall through to create */ }
  const record = {
    install_id: randomUUID(),
    created_at: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(record, null, 2), { mode: 0o600 });
  return record;
}

// ─── Module state ─────────────────────────────────────────────────────────
let _install = null;           // { install_id, created_at }
let _supabase = null;          // anon-key Supabase client (no auth — bridge
                               // doesn't have a user identity; it talks to
                               // the edge functions which use service role
                               // server-side).
let _channel = null;           // Realtime broadcast channel once paired.
let _state = "uninit";         // 'uninit' | 'unpaired' | 'pairing' | 'paired' | 'connected' | 'error'
let _stateDetail = null;       // human-readable subtitle for the menu bar
let _pairCode = null;          // last begin-pair response cached for the UI
let _pairUrl = null;           //
let _statusTimer = null;       // setInterval handle for /status polling
let _onState = null;           // callback into electron/main for menu refresh
let _onDispatch = null;        // callback into server.js for dispatch routing
let _userId = null;            // populated by /status after pair completes
let _heartbeatTimer = null;    // setInterval for /status while connected
let _tunnelUrl = null;         // latest cloudflared trycloudflare URL, set
                               // by lib/bridgeCloudflared.js via setTunnelUrl.
                               // Republished to veronum_bridges.tunnel_url
                               // on every poll (and immediately on change).

function setState(next, detail) {
  if (_state === next && _stateDetail === detail) return;
  _state = next;
  _stateDetail = detail || null;
  console.log(`[bridge] state=${_state}${detail ? " (" + detail + ")" : ""}`);
  _onState?.({ state: _state, detail: _stateDetail, userId: _userId, pairCode: _pairCode, pairUrl: _pairUrl });
}

// ─── Public API ───────────────────────────────────────────────────────────
function getInstallId() {
  if (!_install) _install = loadOrCreateInstall();
  return _install.install_id;
}

// Return the paired user's id (null if unpaired). Populated by poll()
// from the edge function's /status response.
function getUserId() {
  return _userId;
}

// Return the supabase client (anon key, no auth context) so other modules
// (lib/billingGate.js) can call SECURITY DEFINER RPCs without wiring
// their own client.
function getSupabaseClient() {
  return _supabase;
}

async function init({ onState, onDispatch }) {
  _onState = onState || (() => {});
  _onDispatch = onDispatch || (() => {});
  _install = loadOrCreateInstall();
  _supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
    realtime: { params: { eventsPerSecond: 10 } },
  });
  console.log(`[bridge] install_id=${_install.install_id.slice(0, 8)}…`);
  setState("unpaired", "checking pair state…");

  // On startup, check whether THIS install is already paired (user might
  // have paired before in a previous session, written to the bridge row
  // already). If so, skip straight to subscribed mode.
  await poll();
  // Begin a continuous heartbeat / re-check loop regardless of current
  // state. Once paired the same poll() doubles as the keep-alive that
  // updates last_seen_at on Supabase (the edge function /status RPCs the
  // heartbeat function under the hood when user_id is set).
  if (_statusTimer) clearInterval(_statusTimer);
  _statusTimer = setInterval(poll, 30_000);

  return { state: () => _state, getInstallId, beginPair, forceUnpair };
}

// Start the pair flow. Returns { pair_code, pair_url }. The menu-bar
// item should hand the user the URL (open in default browser).
async function beginPair() {
  setState("pairing", "minting pair code…");
  try {
    const res = await fetch(`${EDGE_FN_BASE}/begin-pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
      body: JSON.stringify({
        install_id: getInstallId(),
        app_version: require("../package.json").version,
        os_version: `${process.platform} ${os.release()}`,
        hostname: os.hostname(),
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setState("error", `pair start failed: ${body?.error || res.status}`);
      throw new Error(body?.error || `HTTP ${res.status}`);
    }
    _pairCode = body.pair_code;
    _pairUrl = body.pair_url;
    setState("pairing", `code: ${_pairCode}`);
    // Speed up polling while a pair is pending — every 4s, so the user
    // sees the menu-bar state change within ~half their first sip of
    // coffee after clicking the link in the browser.
    if (_statusTimer) clearInterval(_statusTimer);
    _statusTimer = setInterval(poll, 4_000);
    return { pair_code: _pairCode, pair_url: _pairUrl };
  } catch (e) {
    setState("error", `pair start failed: ${e.message}`);
    throw e;
  }
}

async function poll() {
  try {
    const res = await fetch(`${EDGE_FN_BASE}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
      body: JSON.stringify({ install_id: getInstallId() }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setState("error", `status failed: ${res.status}`);
      return;
    }
    _userId = body.user_id || null;

    if (body.paired) {
      if (_state !== "connected") {
        // First time we see paired=true — subscribe to the channel.
        await connectChannel(body.channel);
        // After connected, slow polling back down to keep-alive cadence.
        if (_statusTimer) clearInterval(_statusTimer);
        _statusTimer = setInterval(poll, 30_000);
      } else {
        // Already connected; this poll just updated last_seen_at remote-side.
      }
      // Re-publish the current tunnel URL on every poll. The /status
      // edge function already bumps last_seen_at via the heartbeat
      // RPC, but it doesn't carry tunnel_url. We piggy-back a second
      // call to the same RPC with the URL so it stays fresh even if
      // an earlier setTunnelUrl() roundtrip dropped. Best-effort —
      // failure just leaves the previous URL in place.
      if (_tunnelUrl) {
        publishTunnelUrlOnce(_tunnelUrl).catch((e) =>
          console.warn(`[bridge] heartbeat tunnel publish failed: ${e.message}`),
        );
      }
    } else if (body.pair_code) {
      _pairCode = body.pair_code;
      setState("pairing", `code: ${body.pair_code}`);
    } else {
      // Not paired and no pending code (e.g. code expired).
      _pairCode = null;
      _pairUrl = null;
      setState("unpaired", "not paired");
    }
  } catch (e) {
    setState("error", `status network: ${e.message}`);
  }
}

async function connectChannel(channelName) {
  // Channel name = "bridge:<install_id>" — server returned it so we
  // don't have to construct (and risk drifting from the server's idea).
  const name = channelName || `bridge:${getInstallId()}`;
  if (_channel) {
    try { await _channel.unsubscribe(); } catch {}
  }
  _channel = _supabase.channel(name, { config: { broadcast: { self: false, ack: false } } });

  // Two channel events both route to the same _onDispatch handler in
  // server.js — the handler decides based on `type` whether to run the
  // legacy direct dispatcher (dispatch.request) or the generic HTTP
  // proxy (bridge.fetch.request).
  _channel.on("broadcast", { event: "dispatch.request" }, ({ payload }) => {
    console.log("[bridge] ← dispatch.request", JSON.stringify(payload).slice(0, 120));
    try {
      _onDispatch?.({ type: "dispatch.request", payload, channelName: name });
    } catch (e) {
      console.warn("[bridge] dispatch handler error:", e);
    }
  });
  _channel.on("broadcast", { event: "bridge.fetch.request" }, ({ payload }) => {
    console.log("[bridge] ← bridge.fetch.request", JSON.stringify(payload).slice(0, 120));
    try {
      _onDispatch?.({ type: "bridge.fetch.request", payload, channelName: name });
    } catch (e) {
      console.warn("[bridge] fetch handler error:", e);
    }
  });
  // Catch-all log so we can see ANY message arriving on this channel,
  // regardless of event name — distinguishes "channel not delivering"
  // from "delivering but wrong event name".
  _channel.on("broadcast", { event: "*" }, (msg) => {
    console.log("[bridge] ← (catchall)", msg?.event, JSON.stringify(msg?.payload || {}).slice(0, 80));
  });

  await new Promise((resolve, reject) => {
    _channel.subscribe((status, err) => {
      if (status === "SUBSCRIBED") {
        setState("connected", `channel ${name.slice(0, 20)}…`);
        resolve();
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        reject(err || new Error(status));
      }
    });
  });
}

// Publish a broadcast event back to whoever's listening on the channel.
// Used by server.js after each delta / done / error during dispatch.
async function sendOutbound(eventName, payload) {
  if (!_channel) {
    console.warn(`[bridge] sendOutbound(${eventName}) called before channel ready`);
    return;
  }
  try {
    const result = await _channel.send({ type: "broadcast", event: eventName, payload });
    console.log(`[bridge] → ${eventName} send result: ${result}`);
  } catch (e) {
    console.warn(`[bridge] sendOutbound(${eventName}) failed:`, e.message);
  }
}

// Call the heartbeat RPC with the current trycloudflare URL. The RPC is
// `SECURITY DEFINER` and gated by install_id (a server-minted UUIDv4 living
// only on disk), so the anon-key daemon can call it directly without
// going through an edge function.
async function publishTunnelUrlOnce(url) {
  if (!_supabase) return;
  const { error } = await _supabase.rpc("veronum_bridge_heartbeat", {
    p_install_id: getInstallId(),
    p_tunnel_url: url,
  });
  if (error) throw new Error(error.message);
}

// Public: called by lib/bridgeCloudflared.js whenever cloudflared logs a
// new trycloudflare URL. Caches the value (poll() reuses it on every
// heartbeat) and pushes it immediately so the browser can pick it up
// without waiting for the next 30s poll.
async function setTunnelUrl(url) {
  if (!url || typeof url !== "string") return;
  if (url === _tunnelUrl) return; // no change, no work
  _tunnelUrl = url;
  console.log(`[bridge] tunnel_url → ${url}`);
  if (_state !== "connected") {
    // Not paired yet — cache it; poll() will publish once we connect.
    return;
  }
  try {
    await publishTunnelUrlOnce(url);
    console.log(`[bridge] tunnel_url published to Supabase`);
  } catch (e) {
    console.warn(`[bridge] tunnel_url publish failed (will retry on next poll): ${e.message}`);
  }
}

async function forceUnpair() {
  // Local clear only — the row stays on Supabase (with the user_id) so
  // the user can re-pair without needing to redo /complete-pair. To
  // FULLY unpair you click "Unpair this Mac" in the chat web app, which
  // hits /functions/v1/veronum-bridge/unpair and deletes the row.
  if (_channel) {
    try { await _channel.unsubscribe(); } catch {}
    _channel = null;
  }
  _userId = null;
  _pairCode = null;
  _pairUrl = null;
  setState("unpaired", "manually disconnected");
}

module.exports = {
  init,
  getInstallId,
  getUserId,
  getSupabaseClient,
  beginPair,
  forceUnpair,
  sendOutbound,
  setTunnelUrl,
};
