/**
 * veronum-bridge — Supabase Edge Function for pairing & status of the
 * Veronum Bridge Mac daemon.
 *
 * === ROLE OVERVIEW ===
 * The Bridge daemon (`Veronum Bridge.app`, ships from
 * github.com/DylanWain/veronum-bridge) runs on a user's Mac and proxies
 * Claude / Cursor dispatches between the user's local CLIs and the
 * user's signed-in browser session at thetoolswebsite.com.
 *
 * The relay itself rides on Supabase **broadcast channels** (no custom
 * WebSocket server). Channel naming uses the bridge's `install_id`
 * (UUIDv4 stored in macOS keychain) so the channel name is
 * unguessable; this function manages the lifecycle around it:
 *
 *   1. Daemon `/begin-pair`s — gets a 6-char pair_code (5-min ttl).
 *   2. Daemon opens the user's browser to
 *      https://www.thetoolswebsite.com/pair-bridge?code=<pair_code>.
 *   3. Browser, signed in via the existing AuthService session, POSTs
 *      `/complete-pair` with the code. We bind that bridge row to the
 *      user.
 *   4. Daemon polls `/status` every ~30s. Once `paired` flips true,
 *      the daemon learns its `user_id` and starts subscribing to its
 *      Realtime broadcast channel `bridge:<install_id>`.
 *
 * === ENDPOINTS (path-routed under /functions/v1/veronum-bridge/*) ===
 *
 *   POST /begin-pair
 *     body: { install_id, app_version?, os_version?, hostname? }
 *     → { pair_code, pair_code_expires_at, pair_url }
 *     Idempotent for unpaired bridges: re-calling with the same
 *     install_id refreshes pair_code + extends ttl. Fails with
 *     bridge_already_paired if user_id is already set (force a server-
 *     side /unpair first to re-pair, intentional friction so a stolen
 *     install_id can't take over an account).
 *
 *   POST /complete-pair
 *     headers: Authorization: Bearer <Supabase session JWT>
 *     body: { pair_code }
 *     → { bridge_id, user_id, install_id }
 *     Verifies the caller is signed in via Supabase Auth (the standard
 *     thetoolswebsite.com session). The veronum_users.id is derived
 *     from the JWT — we never trust a user_id parameter from the
 *     client. Atomically transitions the bridge to paired state.
 *
 *   POST /status
 *     body: { install_id }
 *     → {
 *         paired: boolean,
 *         user_id: uuid | null,
 *         channel: 'bridge:<install_id>' | null,
 *         pair_code: string | null,           // populated if still mid-pair
 *         pair_code_expires_at: timestamp | null,
 *       }
 *     Also bumps last_seen_at on the bridge row so the web UI can show
 *     an accurate "online" dot. The daemon calls this every ~30s.
 *
 *   POST /unpair
 *     headers: Authorization: Bearer <Supabase session JWT>
 *     body: { bridge_id }
 *     → { ok: true }
 *     Lets a signed-in user delete one of their own paired bridges
 *     (e.g. "Macbook stolen, revoke its access"). The deleted row's
 *     subscriptions on the bridge:<install_id> channel will continue
 *     to receive nothing — the relay protocol layer treats absence-of-
 *     bridge-row as deauthorized.
 *
 * === DEPLOY ===
 *
 *   supabase functions deploy veronum-bridge --no-verify-jwt
 *
 * We pass --no-verify-jwt because /begin-pair and /status are called
 * by the daemon BEFORE it has any JWT (it only has its install_id).
 * The /complete-pair and /unpair handlers verify the auth header
 * themselves below.
 */

// @ts-expect-error — Deno-only import, resolved at deploy
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

// @ts-expect-error — Deno globals
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
// @ts-expect-error — Deno globals
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
// @ts-expect-error — Deno globals
const SUPABASE_SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// thetoolswebsite.com is the canonical pair page. Configurable so we
// can point at vercel previews / staging without code changes.
// @ts-expect-error — Deno globals
const PAIR_BASE_URL = Deno.env.get("VERONUM_PAIR_BASE_URL") ||
  "https://www.thetoolswebsite.com/pair-bridge";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

// ─── auth helper ────────────────────────────────────────────────────────────
// /complete-pair and /unpair require a Supabase-authenticated browser
// session (the user signed in at thetoolswebsite.com via the existing
// AuthService flow). We validate the JWT and look up the matching
// veronum_users.id — never trust a user_id from the request body.
async function veronumUserIdFromAuth(req: Request): Promise<string | null> {
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) return null;

  // Validate via Supabase Auth (this calls /auth/v1/user under the hood,
  // which returns 401 if the token is invalid/expired).
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data, error } = await userClient.auth.getUser();
  if (error || !data?.user) return null;

  // The Supabase auth user id is what auth.uid() returns in RLS, and
  // matches veronum_users.id (single-source identity model).
  return data.user.id;
}

// ─── /begin-pair ───────────────────────────────────────────────────────────
async function handleBeginPair(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  const installId = String(body.install_id || "").trim();
  if (!installId || installId.length < 16) {
    return jsonResponse({ error: "install_id required" }, 400);
  }

  const { data, error } = await supabase.rpc("veronum_bridge_begin_pair", {
    p_install_id: installId,
    p_app_version: body.app_version || null,
    p_os_version: body.os_version || null,
    p_hostname: body.hostname || null,
  });

  if (error) {
    // The RPC throws `bridge_already_paired` if the row exists and is
    // bound to a user. Surface that distinctly so the daemon UI can
    // explain (and offer "unpair this Mac first").
    if (/bridge_already_paired/.test(error.message)) {
      return jsonResponse({ error: "bridge_already_paired" }, 409);
    }
    console.error("[veronum-bridge] begin-pair rpc error:", error);
    return jsonResponse({ error: "begin_pair_failed", detail: error.message }, 500);
  }

  // RPC returns a row of veronum_bridges.
  const bridge = Array.isArray(data) ? data[0] : data;
  return jsonResponse({
    pair_code: bridge.pair_code,
    pair_code_expires_at: bridge.pair_code_expires_at,
    pair_url: `${PAIR_BASE_URL}?code=${encodeURIComponent(bridge.pair_code)}`,
  });
}

// ─── /complete-pair ────────────────────────────────────────────────────────
async function handleCompletePair(req: Request): Promise<Response> {
  const userId = await veronumUserIdFromAuth(req);
  if (!userId) return jsonResponse({ error: "unauthorized" }, 401);

  const body = await req.json().catch(() => ({}));
  const pairCode = String(body.pair_code || "").trim().toUpperCase();
  if (!pairCode || pairCode.length !== 6) {
    return jsonResponse({ error: "pair_code required (6 chars)" }, 400);
  }

  const { data, error } = await supabase.rpc("veronum_bridge_complete_pair", {
    p_pair_code: pairCode,
    p_user_id: userId,
  });

  if (error) {
    if (/invalid_or_expired_pair_code/.test(error.message)) {
      return jsonResponse({ error: "invalid_or_expired_pair_code" }, 404);
    }
    console.error("[veronum-bridge] complete-pair rpc error:", error);
    return jsonResponse({ error: "complete_pair_failed", detail: error.message }, 500);
  }

  const bridge = Array.isArray(data) ? data[0] : data;
  return jsonResponse({
    bridge_id: bridge.id,
    user_id: bridge.user_id,
    install_id: bridge.install_id,
    hostname: bridge.hostname,
  });
}

// ─── /status ───────────────────────────────────────────────────────────────
// Lightweight, called every ~30s by the daemon. Doubles as a heartbeat:
// while the row exists and a user_id is set, last_seen_at gets bumped.
async function handleStatus(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  const installId = String(body.install_id || "").trim();
  if (!installId) return jsonResponse({ error: "install_id required" }, 400);

  // SELECT first to know whether paired (and to discover user_id).
  const { data: bridge, error: selectErr } = await supabase
    .from("veronum_bridges")
    .select("id, user_id, install_id, pair_code, pair_code_expires_at, paired_at")
    .eq("install_id", installId)
    .maybeSingle();

  if (selectErr) {
    console.error("[veronum-bridge] status select error:", selectErr);
    return jsonResponse({ error: "status_failed", detail: selectErr.message }, 500);
  }

  if (!bridge) {
    // Daemon's never been registered. Caller should hit /begin-pair.
    return jsonResponse({
      paired: false,
      user_id: null,
      channel: null,
      pair_code: null,
      pair_code_expires_at: null,
    });
  }

  // Bump last_seen_at while paired. We only update if paired so an
  // abandoned (never-completed) pair row doesn't masquerade as alive.
  if (bridge.user_id) {
    await supabase.rpc("veronum_bridge_heartbeat", { p_install_id: installId });
  }

  return jsonResponse({
    paired: !!bridge.user_id,
    user_id: bridge.user_id,
    channel: bridge.user_id ? `bridge:${installId}` : null,
    pair_code: bridge.pair_code,
    pair_code_expires_at: bridge.pair_code_expires_at,
  });
}

// ─── /unpair ───────────────────────────────────────────────────────────────
async function handleUnpair(req: Request): Promise<Response> {
  const userId = await veronumUserIdFromAuth(req);
  if (!userId) return jsonResponse({ error: "unauthorized" }, 401);

  const body = await req.json().catch(() => ({}));
  const bridgeId = String(body.bridge_id || "").trim();
  if (!bridgeId) return jsonResponse({ error: "bridge_id required" }, 400);

  // Delete only if owned by the calling user. RLS would enforce this
  // for an anon-key client, but we're on service role here so the
  // .eq("user_id", userId) is the actual gate.
  const { error } = await supabase
    .from("veronum_bridges")
    .delete()
    .eq("id", bridgeId)
    .eq("user_id", userId);

  if (error) {
    console.error("[veronum-bridge] unpair error:", error);
    return jsonResponse({ error: "unpair_failed", detail: error.message }, 500);
  }

  return jsonResponse({ ok: true });
}

// ─── router ────────────────────────────────────────────────────────────────
// @ts-expect-error — Deno serve
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  const url = new URL(req.url);
  // Supabase routes /functions/v1/<fn>/* through the same function;
  // last non-empty segment is the action.
  const action = url.pathname.split("/").filter(Boolean).pop();

  try {
    if (action === "begin-pair" && req.method === "POST") {
      return await handleBeginPair(req);
    }
    if (action === "complete-pair" && req.method === "POST") {
      return await handleCompletePair(req);
    }
    if (action === "status" && req.method === "POST") {
      return await handleStatus(req);
    }
    if (action === "unpair" && req.method === "POST") {
      return await handleUnpair(req);
    }
    return jsonResponse({ error: "not_found", action }, 404);
  } catch (err) {
    console.error("[veronum-bridge] unhandled:", err);
    return jsonResponse(
      { error: "internal_error", message: (err as Error).message },
      500,
    );
  }
});
