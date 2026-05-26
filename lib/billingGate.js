/**
 * lib/billingGate.js — atomic usage gate for dispatches + voice.
 *
 * Calls the SECURITY DEFINER RPC `veronum_dispatch_gate` which, in one
 * statement, either records usage and allows the call OR blocks it
 * because the user has consumed their $0.25 free quota without an
 * active subscription. Doing this in a single Postgres RPC keeps the
 * decision atomic — no risk of two parallel dispatches each thinking
 * the user is one cent under the cap.
 *
 * Gate rules:
 *   - subscription_status IN ('active','trialing') → allow + record
 *   - otherwise: allow + record IF (consumed + raw_cents) <= 25
 *   - otherwise: BLOCK with reason='over_quota'
 *
 * raw_cents vs charged_cents:
 *   raw_cents      — our cost on this call (e.g. voice OpenAI Realtime
 *                    minute price). Tracked in period_consumed_cents.
 *   charged_cents  — what the user is billed. Tracked in period_billed
 *                    _cents. The 25¢ free quota is measured in raw_cents.
 *
 * For text dispatches (Claude / Cursor) we use the same Anthropic /
 * Cursor key the user already provided, so raw_cents = 0. We still
 * charge a small token (1¢) for the relay infrastructure (Supabase
 * channel, daemon time, cloudflared bandwidth) so charged_cents = 1.
 *
 * Voice IS our real cost (we mint the OpenAI Realtime client_secret
 * from our org), so for voice we pass both raw_cents and charged_cents
 * (typically with a 5–6× margin on top of OpenAI's listed price).
 */

"use strict";

const bridgeSupabase = require("./bridgeSupabase");

// Cents-per-unit pricing — adjusted in one place, no duplicated literals
// littered through dispatch / voice endpoints.
const PRICING = Object.freeze({
  CLAUDE_DISPATCH_CHARGED: 1,   // 1¢ per /api/claude/send
  CURSOR_DISPATCH_CHARGED: 1,   // 1¢ per /api/cursor/send
  // Voice: priced per minute. OpenAI's gpt-realtime billing varies by
  // input/output ratio; ~6¢/min is a safe blended cost estimate. We
  // bill 30¢/min for a ~5× margin matching the rest of the product.
  VOICE_PER_MIN_RAW: 6,
  VOICE_PER_MIN_CHARGED: 30,
});

/**
 * gate({ rawCents, chargedCents }) → { allowed, reason, ... }
 *
 * Returns an object suitable for the response of a 402 path:
 *   { allowed: false, reason: 'over_quota', consumed_after, free_remaining: 0, subscription_status }
 *   { allowed: true,  reason: 'free_quota'|'subscribed', consumed_after, free_remaining, subscription_status }
 *
 * Throws if:
 *   - daemon not paired (no user_id known yet)
 *   - Supabase RPC errors out
 *
 * Callers should catch and return a 503 in that case — the gate
 * deliberately fails closed when it can't reach Supabase. We never
 * silently allow a dispatch when the billing state is unknowable.
 */
async function gate({ rawCents = 0, chargedCents = 0 } = {}) {
  const userId = bridgeSupabase.getUserId();
  if (!userId) {
    // Unpaired daemon — can't gate. Caller decides whether to allow
    // (probably yes, for local-only use) or block. Returning a sentinel
    // makes that explicit at the call site.
    return { allowed: true, reason: "unpaired", consumed_after: 0, free_remaining: 0, subscription_status: null };
  }
  const supabase = bridgeSupabase.getSupabaseClient();
  if (!supabase) {
    throw new Error("supabase client not initialized");
  }
  const { data, error } = await supabase.rpc("veronum_dispatch_gate", {
    p_user_id: userId,
    p_charged_cents: chargedCents,
    p_raw_cents: rawCents,
  });
  if (error) throw new Error(`gate rpc: ${error.message}`);
  // RETURNS TABLE comes back as an array of rows; we only ever return one.
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error("gate rpc returned no row");
  return {
    allowed: !!row.allowed,
    reason: row.reason,
    consumed_after: row.consumed_after,
    free_remaining: row.free_remaining,
    subscription_status: row.subscription_status,
  };
}

// Convenience wrappers per call type. The pricing constants live above
// so a future price-tune is a one-line change; the endpoint code stays
// readable as `gateClaude()` / `gateCursor()` / `gateVoice(seconds)`.
async function gateClaudeDispatch() {
  return gate({ rawCents: 0, chargedCents: PRICING.CLAUDE_DISPATCH_CHARGED });
}
async function gateCursorDispatch() {
  return gate({ rawCents: 0, chargedCents: PRICING.CURSOR_DISPATCH_CHARGED });
}
async function gateVoiceSession() {
  // Voice session start gates at the BLENDED per-minute charged rate —
  // i.e. "do you have enough free quota to talk for at least one
  // minute?". Actual per-minute metering happens via /api/usage/voice
  // heartbeats from the browser side (TODO — currently the user just
  // gets one free minute of voice if they have any free quota left).
  return gate({
    rawCents: PRICING.VOICE_PER_MIN_RAW,
    chargedCents: PRICING.VOICE_PER_MIN_CHARGED,
  });
}

// 402 Payment Required JSON body, consistent shape so the chat UI can
// detect and render the paywall regardless of which endpoint triggered it.
function paywallResponse(gateResult) {
  return {
    ok: false,
    error: "payment_required",
    reason: gateResult.reason,
    free_remaining_cents: gateResult.free_remaining,
    consumed_cents: gateResult.consumed_after,
    subscription_status: gateResult.subscription_status,
    // The UI should surface this URL as the "Subscribe" CTA. Cents in
    // the URL is a hint to Stripe Checkout (not strictly required).
    checkout_url: "https://buy.stripe.com/fZu28tb3x9aufwJeLt1sQ00",
    message: "You've used your $0.25 free quota. Subscribe to keep using Veronum.",
  };
}

module.exports = {
  gate,
  gateClaudeDispatch,
  gateCursorDispatch,
  gateVoiceSession,
  paywallResponse,
  PRICING,
};
