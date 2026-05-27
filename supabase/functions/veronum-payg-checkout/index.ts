// supabase/functions/veronum-payg-checkout/index.ts
//
// Creates a Stripe Checkout Session for the PAYG (pay-as-you-go) plan
// at the 3x metered price. Tags metadata.plan='payg' so stripe-webhook
// sets users.tier='payg' on activation, which makes the daemon's
// veronum_dispatch_gate apply the 3x multiplier.
//
// Auth: requires the caller's Supabase JWT. user_id is derived from
// the JWT — body-supplied user_id is never trusted.
//
// Why no `import` of @supabase/supabase-js: Supabase Edge Functions
// deployed via the Management API PATCH endpoint don't run the eszip
// bundler, so external imports fail at boot. We hit the PostgREST and
// Auth APIs over raw fetch instead — zero external imports.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
const STRIPE_PRICE_PAYG =
  Deno.env.get("STRIPE_PRICE_PAYG") ?? "price_1TKxeVPMT1e1NaXsjiHepxsY";
const PUBLIC_URL =
  Deno.env.get("VERONUM_PUBLIC_URL") ?? "https://www.thetoolswebsite.com";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

// Validate the JWT via Supabase Auth's /auth/v1/user endpoint.
async function userFromJwt(req) {
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) return null;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) return null;
  const u = await res.json();
  if (!u?.id) return null;
  return { id: u.id, email: u.email ?? null };
}

// Read a single row from PostgREST as service_role (bypasses RLS).
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

async function pgrstPatch(table, query, body) {
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

// Stripe REST: form-encoded POST.
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

  const user = await userFromJwt(req);
  if (!user) return jsonResponse({ error: "unauthorized" }, 401);

  const body = await req.json().catch(() => ({}));
  const returnTo = body.return_to || `${PUBLIC_URL}/chat?stripe_success=1`;

  // Find or create Stripe customer.
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
  if (!customerId) {
    try {
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
    } catch (err) {
      return jsonResponse(
        { error: "stripe_customer_create_failed", detail: err.message },
        500,
      );
    }
  }

  // Create the metered subscription Checkout Session.
  try {
    const session = await stripePost("checkout/sessions", {
      mode: "subscription",
      customer: customerId,
      "line_items[0][price]": STRIPE_PRICE_PAYG,
      "metadata[user_id]": user.id,
      "metadata[plan]": "payg",
      "subscription_data[metadata][user_id]": user.id,
      "subscription_data[metadata][plan]": "payg",
      success_url: returnTo,
      cancel_url: `${PUBLIC_URL}/chat`,
      client_reference_id: user.id,
    });
    return jsonResponse({ checkoutUrl: session.url });
  } catch (err) {
    return jsonResponse(
      { error: "stripe_session_failed", detail: err.message },
      500,
    );
  }
});
