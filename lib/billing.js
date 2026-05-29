/**
 * lib/billing.js — daemon-side billing endpoints for the in-app plan
 * modal and the "subscribe to keep using Veronum" paywall.
 *
 * No Stripe secret on the daemon — all Subscribe/PAYG/Manage flows
 * hand off to Stripe's hosted pages (Payment Links + Customer Portal
 * landing). The user_id is pre-baked into the URL via
 * client_reference_id so the existing stripe-webhook function can
 * resolve the right public.users row on payment success.
 *
 * Endpoints:
 *   GET /api/billing/state  → current tier / quota / sub status
 *   GET /api/billing/links  → Subscribe / PAYG / Manage URLs ready to
 *                             window.open() from the modal
 */

"use strict";

const billingGate = require("./billingGate");
const bridgeSupabase = require("./bridgeSupabase");

// Edge function that mints Stripe Checkout / Customer Portal sessions
// for the daemon. Auth is install-id-based — the function looks up the
// paired user via veronum_bridges and uses that user's stripe_customer.
const SUPABASE_URL = "https://synpjcammfjebwsmtfpz.supabase.co";
const BILLING_BRIDGE_URL = `${SUPABASE_URL}/functions/v1/veronum-billing-bridge`;

function ensureBridge() {
  const supabase = bridgeSupabase.getSupabaseClient();
  if (!supabase) throw new Error("bridge_not_initialized");
  const userId = bridgeSupabase.getUserId();
  return { supabase, userId };
}

async function fetchState(userId) {
  const { supabase } = ensureBridge();
  const { data, error } = await supabase.rpc("veronum_get_billing_state", {
    p_user_id: userId,
  });
  if (error) throw new Error(`billing-state rpc: ${error.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  return row || null;
}

// Call the install-id-authed billing-bridge edge function to mint a
// Stripe URL for the requested action. Returns the URL on success;
// throws on failure with a useful message.
// Same publishable key bridgeSupabase.js uses. Hardcoded here so we
// don't have to plumb the key out of the client at runtime.
const SUPABASE_ANON_KEY = "sb_publishable_1h3d9dMB7f5JK_8aLHR5ig_GiurDzuS";

async function mintStripeUrl(action) {
  const installId = bridgeSupabase.getInstallId?.();
  if (!installId) throw new Error("daemon_unpaired_no_install_id");
  const res = await fetch(BILLING_BRIDGE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      "x-veronum-install-id": installId,
    },
    body: JSON.stringify({ install_id: installId, action }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      data.error
        ? `${data.error}${data.detail ? `: ${data.detail}` : ""}`
        : `edge-fn ${res.status}`,
    );
  }
  if (!data?.url) throw new Error("edge-fn returned no url");
  return data.url;
}

function mountBilling(app) {
  app.get("/api/billing/state", async (_req, res) => {
    try {
      const userId = bridgeSupabase.getUserId();
      if (!userId) {
        // Local-only / unpaired: synthesize a "no-billing" snapshot so
        // the UI can still render without errors.
        return res.json({
          ok: true,
          unpaired: true,
          tier: "free",
          subscription_status: "none",
          period_consumed_cents: 0,
          period_billed_cents: 0,
          free_remaining_cents: 25,
          has_active_subscription: false,
          over_quota: false,
          is_admin: false,
        });
      }
      const row = await fetchState(userId);
      if (!row) {
        return res.status(500).json({ ok: false, error: "no_state_row" });
      }
      res.json({ ok: true, userId, ...row });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Mint endpoints: each takes no body, calls the edge function with
  // the daemon's install_id, returns { url } that the UI then opens
  // in a new tab. Async per click — avoids stale Stripe sessions and
  // means we don't burn Stripe API quota until the user actually clicks.
  function mountMintEndpoint(routePath, action) {
    app.post(routePath, async (_req, res) => {
      try {
        const url = await mintStripeUrl(action);
        res.json({ ok: true, url });
      } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
      }
    });
  }
  mountMintEndpoint("/api/billing/checkout-flat", "checkout-flat");
  mountMintEndpoint("/api/billing/checkout-payg", "checkout-payg");
  mountMintEndpoint("/api/billing/portal", "portal");
}

module.exports = { mountBilling };
