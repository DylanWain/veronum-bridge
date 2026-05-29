// supabase/functions/veronum-billing-bridge/index.ts
//
// Mints Stripe Checkout + Customer Portal sessions for a paired
// Veronum daemon. Unlike veronum-payg-checkout (which expects the
// marketing-site user's JWT), this one trusts the daemon's install_id
// — the same identifier the bridge uses to find its user_id via the
// veronum_bridges table. So the desktop / mobile daemon UI (which
// never has a JWT) can drive Subscribe / PAYG / Manage flows.
//
// Three actions, all POST:
//   { install_id, action: "checkout-flat",  return_to? }
//   { install_id, action: "checkout-payg",  return_to? }
//   { install_id, action: "portal",         return_to? }
//
// Auth:
//   install_id MUST exist in veronum_bridges AND have a non-null
//   user_id (i.e. the bridge is paired). Anyone with an install_id
//   can mint sessions FOR THE PAIRED USER ONLY — which is exactly
//   what the daemon needs to do.
//
// No external imports; PostgREST + Stripe over raw fetch.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY") ?? "";

const STRIPE_PRICE_FLAT =
  Deno.env.get("STRIPE_PRICE_FLAT") ?? "price_1TA1yPPMT1e1NaXsooo8ckHI";
const STRIPE_PRICE_OVERAGE_2X =
  Deno.env.get("STRIPE_PRICE_OVERAGE_2X") ?? "price_1TKxZNPMT1e1NaXstQ2PJhlK";
const STRIPE_PRICE_PAYG =
  Deno.env.get("STRIPE_PRICE_PAYG") ?? "price_1TKxeVPMT1e1NaXsjiHepxsY";
const PUBLIC_URL =
  Deno.env.get("VERONUM_PUBLIC_URL") ?? "https://chat.thetoolswebsite.com";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-veronum-install-id",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

async function pgrstGetSingle(table, query) {
  const url = `${SUPABASE_URL}/rest/v1/${table}?${query}&limit=1`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) return null;
  const arr = await res.json();
  return Array.isArray(arr) && arr.length ? arr[0] : null;
}

async function pgrstUpsert(table, body, onConflict) {
  await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${onConflict}`, {
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

async function pgrstPatch(table, query, body) {
  await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
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

async function stripePost(path, params) {
  const body = new URLSearchParams(params).toString();
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(
      `Stripe ${path} ${res.status}: ${data?.error?.message ?? JSON.stringify(data)}`,
    );
  }
  return data;
}

// Resolve user from install_id via the veronum_bridges mapping.
// Bridge must be paired (user_id not null). Also fetches email from
// auth.users for Stripe customer creation.
async function userFromInstallId(installId) {
  if (!installId || typeof installId !== "string" || installId.length < 16) {
    return null;
  }
  const bridge = await pgrstGetSingle(
    "veronum_bridges",
    `install_id=eq.${encodeURIComponent(installId)}&select=user_id`,
  );
  if (!bridge?.user_id) return null;
  // auth.users lives in the auth schema — PostgREST exposes it via the
  // `?schema=` header. We need email for Stripe customer creation.
  const url = `${SUPABASE_URL}/auth/v1/admin/users/${bridge.user_id}`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  let email = null;
  if (res.ok) {
    const u = await res.json();
    email = u?.email ?? null;
  }
  return { id: bridge.user_id, email };
}

// Find-or-create the Stripe customer for this user. Persists the
// stripe_customer_id back to public.users + public.subscriptions so
// future invocations don't re-create.
async function ensureStripeCustomer(user) {
  let customerId = null;
  {
    const subRow = await pgrstGetSingle(
      "subscriptions",
      `user_id=eq.${user.id}&select=stripe_customer_id`,
    );
    customerId = subRow?.stripe_customer_id ?? null;
  }
  if (!customerId) {
    const userRow = await pgrstGetSingle(
      "users",
      `id=eq.${user.id}&select=stripe_customer_id`,
    );
    customerId = userRow?.stripe_customer_id ?? null;
  }
  if (customerId) return customerId;

  const params = { "metadata[user_id]": user.id };
  if (user.email) params.email = user.email;
  const customer = await stripePost("customers", params);
  customerId = customer.id;
  await pgrstUpsert(
    "subscriptions",
    { user_id: user.id, stripe_customer_id: customerId },
    "user_id",
  );
  await pgrstPatch("users", `id=eq.${user.id}`, { stripe_customer_id: customerId });
  return customerId;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }
  if (!STRIPE_SECRET_KEY) {
    return jsonResponse({ error: "config_missing", detail: "STRIPE_SECRET_KEY not set" }, 500);
  }

  const body = await req.json().catch(() => ({}));
  const installId =
    req.headers.get("x-veronum-install-id") || body.install_id || "";
  const action = String(body.action || "");
  const returnTo = body.return_to || `${PUBLIC_URL}/?stripe_success=1`;
  const cancelTo = body.cancel_to || `${PUBLIC_URL}/`;

  const user = await userFromInstallId(installId);
  if (!user) {
    return jsonResponse({ error: "unpaired_or_unknown_install" }, 401);
  }

  let customerId;
  try {
    customerId = await ensureStripeCustomer(user);
  } catch (err) {
    return jsonResponse(
      { error: "stripe_customer_create_failed", detail: err.message },
      500,
    );
  }

  try {
    if (action === "checkout-flat") {
      // $25/mo flat + 2x metered overage on the same subscription.
      const session = await stripePost("checkout/sessions", {
        mode: "subscription",
        customer: customerId,
        "line_items[0][price]": STRIPE_PRICE_FLAT,
        "line_items[0][quantity]": "1",
        "line_items[1][price]": STRIPE_PRICE_OVERAGE_2X,
        "metadata[user_id]": user.id,
        "metadata[plan]": "flat",
        "subscription_data[metadata][user_id]": user.id,
        "subscription_data[metadata][plan]": "flat",
        success_url: returnTo,
        cancel_url: cancelTo,
        client_reference_id: user.id,
      });
      return jsonResponse({ ok: true, url: session.url });
    }

    if (action === "checkout-payg") {
      const session = await stripePost("checkout/sessions", {
        mode: "subscription",
        customer: customerId,
        "line_items[0][price]": STRIPE_PRICE_PAYG,
        "metadata[user_id]": user.id,
        "metadata[plan]": "payg",
        "subscription_data[metadata][user_id]": user.id,
        "subscription_data[metadata][plan]": "payg",
        success_url: returnTo,
        cancel_url: cancelTo,
        client_reference_id: user.id,
      });
      return jsonResponse({ ok: true, url: session.url });
    }

    if (action === "portal") {
      const session = await stripePost("billing_portal/sessions", {
        customer: customerId,
        return_url: returnTo,
      });
      return jsonResponse({ ok: true, url: session.url });
    }

    return jsonResponse(
      { error: "unknown_action", detail: `action must be one of checkout-flat, checkout-payg, portal` },
      400,
    );
  } catch (err) {
    return jsonResponse(
      { error: "stripe_session_failed", detail: err.message },
      500,
    );
  }
});
