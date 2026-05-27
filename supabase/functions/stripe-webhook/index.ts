// supabase/functions/stripe-webhook/index.ts
//
// Stripe → Veronum sync. Verifies the Stripe signature, then mirrors
// subscription state into public.subscriptions and public.users so the
// daemon's billing gate (lib/billingGate.js + veronum_dispatch_gate
// RPC) sees up-to-date status.
//
// Why no `import` of @supabase/supabase-js or std/http: Supabase
// Edge Functions deployed via the Management API PATCH endpoint don't
// run the eszip bundler, so external imports fail at boot. We use
// Deno.serve + raw fetch to PostgREST + raw fetch to Stripe instead.
//
// 2026-05-26 patch (vs original v7):
//   1. Resolve user_id with a 4-level fallback chain: metadata.user_id
//      → client_reference_id → subscriptions.stripe_customer_id →
//      users.stripe_customer_id. Closes the Payment-Link-no-metadata
//      gap that left brand-new subscribers unlinked.
//   2. Read metadata.plan and set users.tier='payg' vs 'chad'
//      accordingly. The PAYG checkout function (veronum-payg-checkout)
//      tags 'payg'; the Payment Link defaults to 'chad'.
//   3. Mirror tier + subscription_status into public.users (the gate's
//      primary signal) on activation; reset usage counters; never
//      overwrite admin rows.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const STRIPE_WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, stripe-signature",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

// HMAC-SHA256 check against Stripe's signature header. Tolerance ±5 min.
async function verifyStripeSignature(payload, sigHeader, secret) {
  const parts = sigHeader.split(",").reduce((acc, p) => {
    const [k, v] = p.split("=");
    acc[k.trim()] = v;
    return acc;
  }, {});
  const timestamp = parts["t"];
  const signature = parts["v1"];
  if (!timestamp || !signature) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp)) > 300) return false;
  const signedPayload = `${timestamp}.${payload}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(signedPayload),
  );
  const expectedSig = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return expectedSig === signature;
}

// ─── PostgREST helpers (service_role bypasses RLS) ────────────────────────
async function pgGet(table, query) {
  const url = `${SUPABASE_URL}/rest/v1/${table}?${query}`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) return null;
  return await res.json();
}

async function pgUpsert(table, body, onConflict) {
  const url = `${SUPABASE_URL}/rest/v1/${table}?on_conflict=${onConflict}`;
  await fetch(url, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(body),
  });
}

async function pgPatch(table, query, body) {
  const url = `${SUPABASE_URL}/rest/v1/${table}?${query}`;
  await fetch(url, {
    method: "PATCH",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(body),
  });
}

// Resolve user_id from a Stripe event object.
async function resolveUserId(obj) {
  // 1. metadata.user_id (set by create-checkout / veronum-payg-checkout)
  if (obj.metadata?.user_id) return obj.metadata.user_id;
  // 2. client_reference_id (set by Payment Link URL param)
  if (obj.client_reference_id) return obj.client_reference_id;
  // 3 + 4. look up by customer id
  const customerId =
    typeof obj.customer === "string" ? obj.customer : obj.customer?.id;
  if (!customerId) return null;
  // 3. subscriptions.stripe_customer_id
  const subRows = await pgGet(
    "subscriptions",
    `stripe_customer_id=eq.${customerId}&user_id=not.is.null&select=user_id&limit=1`,
  );
  if (subRows && subRows[0]?.user_id) return subRows[0].user_id;
  // 4. users.stripe_customer_id
  const userRows = await pgGet(
    "users",
    `stripe_customer_id=eq.${customerId}&select=id&limit=1`,
  );
  if (userRows && userRows[0]?.id) return userRows[0].id;
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const body = await req.text();
  const sigHeader = req.headers.get("stripe-signature") || "";
  const valid = await verifyStripeSignature(body, sigHeader, STRIPE_WEBHOOK_SECRET);
  if (!valid) {
    console.error("Webhook signature verification failed");
    return jsonResponse({ error: "Invalid signature" }, 400);
  }

  let event;
  try {
    event = JSON.parse(body);
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400);
  }
  console.log(`Stripe webhook: ${event.type}`);

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        const userId = await resolveUserId(session);
        const customerId =
          typeof session.customer === "string"
            ? session.customer
            : session.customer?.id ?? null;
        const subscriptionId =
          typeof session.subscription === "string"
            ? session.subscription
            : session.subscription?.id ?? null;
        // tier='payg' when veronum-payg-checkout tagged the session,
        // otherwise default to 'chad' for the flat $25/mo Payment Link.
        const planMeta = String(session.metadata?.plan ?? "").toLowerCase();
        const tier = planMeta === "payg" ? "payg" : "chad";
        if (userId) {
          await pgUpsert(
            "subscriptions",
            {
              user_id: userId,
              status: "active",
              stripe_customer_id: customerId,
              stripe_subscription_id: subscriptionId,
              tier,
              paid_at: new Date().toISOString(),
            },
            "user_id",
          );
          // Mirror into public.users for the gate's primary signal.
          // .neq('tier','admin') keeps admin rows untouched.
          await pgPatch(
            "users",
            `id=eq.${userId}&tier=neq.admin`,
            {
              tier,
              subscription_status: "active",
              stripe_customer_id: customerId,
              stripe_subscription_id: subscriptionId,
              period_consumed_cents: 0,
              period_billed_cents: 0,
              period_billed_to_stripe_cents: 0,
            },
          );
          console.log(`User ${userId} activated as ${tier} via checkout`);
        } else {
          console.warn(
            `checkout.session.completed unresolved: customer=${customerId} session=${session.id}`,
          );
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const subscription = event.data.object;
        const userId = await resolveUserId(subscription);
        const status = subscription.status;
        const customerId =
          typeof subscription.customer === "string"
            ? subscription.customer
            : subscription.customer?.id;
        const planMeta = String(subscription.metadata?.plan ?? "").toLowerCase();
        const activeTier = planMeta === "payg" ? "payg" : "chad";
        if (userId) {
          await pgUpsert(
            "subscriptions",
            {
              user_id: userId,
              status,
              stripe_subscription_id: subscription.id,
              stripe_customer_id: customerId,
              tier: activeTier,
            },
            "user_id",
          );
          await pgPatch(
            "users",
            `id=eq.${userId}&tier=neq.admin`,
            {
              subscription_status: status,
              tier:
                status === "active" || status === "trialing"
                  ? activeTier
                  : "free",
            },
          );
          console.log(`User ${userId} subscription ${status} as ${activeTier}`);
        } else {
          console.warn(
            `customer.subscription.${event.type.split(".").pop()} unresolved: customer=${customerId} sub=${subscription.id}`,
          );
        }
        break;
      }
      case "customer.subscription.deleted": {
        const subscription = event.data.object;
        const userId = await resolveUserId(subscription);
        if (userId) {
          await pgPatch(
            "subscriptions",
            `user_id=eq.${userId}`,
            { status: "canceled" },
          );
          await pgPatch(
            "users",
            `id=eq.${userId}&tier=neq.admin`,
            { subscription_status: "canceled", tier: "free" },
          );
          console.log(`User ${userId} subscription canceled`);
        }
        break;
      }
      default:
        break;
    }
  } catch (err) {
    console.error("[stripe-webhook] handler error:", err);
    return jsonResponse(
      { error: "internal_error", message: err?.message ?? String(err) },
      500,
    );
  }

  return jsonResponse({ received: true, type: event.type });
});
