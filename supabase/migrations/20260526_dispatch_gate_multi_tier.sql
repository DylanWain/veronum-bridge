-- 20260526_dispatch_gate_multi_tier.sql
--
-- Upgrades veronum_dispatch_gate from binary (subscribed/free) to the
-- full three-tier pricing model the Stripe products encode:
--
--   Free        → $0.25 free quota (period_billed_cents <= 25), then BLOCK
--   Flat sub    → $25/mo, 1x for first $25 of usage, then 2x metered
--   PAYG        → no flat, 3x metered from cent one
--   Admin       → bypass, never gated, never counted
--
-- Stripe prices the multipliers map to (price IDs in lib/billingGate.js):
--   1x  → covered by the flat $25/mo subscription (no meter events)
--   2x  → price_1TKxZNPMT...  ($0.02/unit on api_cost_raw_cents meter)
--   3x  → price_1TKxeVPMT...  ($0.03/unit on api_cost_raw_cents meter)
--
-- The gate updates period_billed_cents with the POST-multiplier value so
-- the chat UI can show "you've used $X" accurately, but the actual
-- Stripe meter events for overage / PAYG are sent by a separate
-- reconciler (TODO) — keeping that out of the daemon avoids putting the
-- Stripe secret key inside the .app bundle.
--
-- Identity is by users.tier:
--   'admin'  → bypass
--   'payg'   → 3x
--   'chad'   → flat $25/mo subscriber (legacy tier name; the column
--              came from a prior product iteration. Renaming would
--              require migrating live subscriber rows so we keep the
--              string as-is.)
--   'free'/'none'/NULL → free quota path

drop function if exists public.veronum_dispatch_gate(uuid, integer, integer);

create or replace function public.veronum_dispatch_gate(
  p_user_id uuid,
  p_charged_cents integer,
  p_raw_cents integer default 0
) returns table (
  allowed boolean,
  reason text,
  consumed_after integer,
  billed_after integer,
  free_remaining_cents integer,
  subscription_status text,
  tier text,
  multiplier integer
)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_consumed int;
  v_billed int;
  v_status text;
  v_tier text;
  v_free_limit constant int := 25;
  v_sub_included constant int := 2500;
  v_multiplier int;
  v_billed_add int;
begin
  select u.period_consumed_cents, u.period_billed_cents, u.subscription_status, u.tier
    into v_consumed, v_billed, v_status, v_tier
  from public.users u where u.id = p_user_id;

  if not found then
    return query select false, 'no_user'::text, 0, 0, 0, null::text, null::text, 1;
    return;
  end if;

  -- Admin: never gated, never recorded.
  if v_tier = 'admin' then
    return query select true, 'admin'::text, v_consumed, v_billed, 1000000, coalesce(v_status, 'admin'), v_tier, 0;
    return;
  end if;

  -- PAYG: 3x always. Always allowed (assumes card on file via PAYG checkout).
  if v_tier = 'payg' then
    v_multiplier := 3;
    v_billed_add := p_charged_cents * v_multiplier;
    update public.users set
      period_consumed_cents = period_consumed_cents + p_raw_cents,
      period_billed_cents   = period_billed_cents + v_billed_add,
      last_call_at = now()
    where id = p_user_id;
    return query select true, 'payg'::text, v_consumed + p_raw_cents,
      v_billed + v_billed_add, 0, coalesce(v_status, 'active'), v_tier, v_multiplier;
    return;
  end if;

  -- Active flat subscriber: 1x for first $25 of billed usage, then 2x.
  if v_status in ('active', 'trialing') then
    if v_billed < v_sub_included then v_multiplier := 1; else v_multiplier := 2; end if;
    v_billed_add := p_charged_cents * v_multiplier;
    update public.users set
      period_consumed_cents = period_consumed_cents + p_raw_cents,
      period_billed_cents   = period_billed_cents + v_billed_add,
      last_call_at = now()
    where id = p_user_id;
    return query select true, 'subscribed'::text, v_consumed + p_raw_cents,
      v_billed + v_billed_add,
      greatest(v_sub_included - (v_billed + v_billed_add), 0),
      v_status, v_tier, v_multiplier;
    return;
  end if;

  -- Free user: cap at 25 billed cents.
  if v_billed + p_charged_cents > v_free_limit then
    return query select false, 'over_quota'::text, v_consumed, v_billed, 0,
      coalesce(v_status, 'none'), coalesce(v_tier, 'free'), 1;
    return;
  end if;

  update public.users set
    period_consumed_cents = period_consumed_cents + p_raw_cents,
    period_billed_cents   = period_billed_cents + p_charged_cents,
    last_call_at = now()
  where id = p_user_id;

  return query select true, 'free_quota'::text, v_consumed + p_raw_cents,
    v_billed + p_charged_cents,
    greatest(v_free_limit - (v_billed + p_charged_cents), 0),
    coalesce(v_status, 'none'), coalesce(v_tier, 'free'), 1;
end;
$$;

grant execute on function public.veronum_dispatch_gate(uuid, integer, integer)
  to anon, authenticated, service_role;

-- veronum_my_billing_state — caller-scoped read for the chat UI.
-- Returns the extra fields the paywall now uses (tier, billed, is_admin).
drop function if exists public.veronum_my_billing_state();

create or replace function public.veronum_my_billing_state()
returns table (
  tier text,
  subscription_status text,
  period_consumed_cents integer,
  period_billed_cents integer,
  free_remaining_cents integer,
  has_active_subscription boolean,
  over_quota boolean,
  is_admin boolean
)
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_uid uuid := auth.uid();
  v_free_limit constant int := 25;
begin
  if v_uid is null then return; end if;
  return query select
    coalesce(u.tier, 'free')::text,
    coalesce(u.subscription_status, 'none')::text,
    coalesce(u.period_consumed_cents, 0)::integer,
    coalesce(u.period_billed_cents, 0)::integer,
    greatest(v_free_limit - coalesce(u.period_billed_cents, 0), 0)::integer,
    (u.subscription_status in ('active', 'trialing'))::boolean,
    (
      u.tier <> 'admin'
      and u.tier <> 'payg'
      and u.subscription_status not in ('active', 'trialing')
      and coalesce(u.period_billed_cents, 0) >= v_free_limit
    )::boolean,
    (u.tier = 'admin')::boolean
  from public.users u where u.id = v_uid;
end;
$$;

grant execute on function public.veronum_my_billing_state()
  to authenticated, anon;
