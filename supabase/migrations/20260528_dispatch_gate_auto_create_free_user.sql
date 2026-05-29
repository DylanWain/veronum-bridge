-- 20260528_dispatch_gate_auto_create_free_user.sql
--
-- Fixes the "first-time user gets blocked with `no_user`" bug.
--
-- The original veronum_dispatch_gate (20260526) returned reason='no_user'
-- when no row existed in public.users for the caller. That meant every
-- brand-new signup hit the gate, got 'no_user', and was blocked from
-- chat / voice / preview until SOMETHING (a trigger? a manual insert?)
-- backfilled the row. There was no such trigger.
--
-- New behavior: the gate INSERTs a free-tier row on the fly when missing
-- and proceeds with normal free-quota evaluation. New users get the full
-- $0.25 quota immediately, no signup ceremony.
--
-- INSERT … ON CONFLICT DO NOTHING is race-safe — two parallel dispatches
-- from the same new user will both succeed, but only one row is created.
--
-- veronum_my_billing_state is updated in lockstep: it now returns a
-- "fresh free user" snapshot when no row exists, so the paywall UI
-- shows "$0.25 free quota remaining" instead of nothing for new users.

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
  v_has_sub boolean;
  v_free_limit constant int := 25;
  v_sub_included constant int := 1500;
  v_multiplier int;
  v_billed_add int;
begin
  -- Look up the user. If missing, lazy-create a free-tier row so the
  -- caller gets their full $0.25 free quota on their very first call.
  -- INSERT ... ON CONFLICT DO NOTHING is race-safe under concurrent
  -- dispatches; the SELECT after always returns the canonical row.
  insert into public.users (id, tier, period_consumed_cents, period_billed_cents)
    values (p_user_id, 'free', 0, 0)
    on conflict (id) do nothing;

  select u.period_consumed_cents, u.period_billed_cents,
         u.subscription_status, u.tier,
         exists(select 1 from public.subscriptions s where s.user_id = u.id and s.status = 'active')
    into v_consumed, v_billed, v_status, v_tier, v_has_sub
  from public.users u where u.id = p_user_id;

  -- Defensive: if the row STILL isn't there (shouldn't happen post-
  -- insert, but RLS or schema mismatch could theoretically swallow it),
  -- fall back to in-memory free defaults so the user isn't blocked.
  if not found then
    v_consumed := 0;
    v_billed := 0;
    v_status := null;
    v_tier := 'free';
    v_has_sub := false;
  end if;

  -- Admin: never gated, never recorded.
  if v_tier = 'admin' then
    return query select true, 'admin'::text, v_consumed, v_billed, 1000000, coalesce(v_status, 'admin'), v_tier, 0;
    return;
  end if;

  -- PAYG: 3x always, always allowed.
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

  -- Active flat subscriber: 1x for first $15 included, then 2x overage.
  if v_tier = 'chad' or v_status in ('active', 'trialing') or v_has_sub then
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
      coalesce(v_status, 'active'), coalesce(v_tier, 'chad'), v_multiplier;
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

-- Mirror the auto-create behavior in the read-only billing state so the
-- UI shows new users "$0.25 free quota remaining" instead of nothing.
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
  v_row public.users;
begin
  if v_uid is null then return; end if;

  -- Lazy-create the same way the dispatch gate does, so a fresh user
  -- who opens the chat UI before sending their first message sees
  -- their full $0.25 quota immediately.
  insert into public.users (id, tier, period_consumed_cents, period_billed_cents)
    values (v_uid, 'free', 0, 0)
    on conflict (id) do nothing;

  select * into v_row from public.users where id = v_uid;
  if not found then
    -- Defensive fallback: synthesize a fresh-free snapshot in memory.
    return query select
      'free'::text,
      'none'::text,
      0::integer,
      0::integer,
      v_free_limit::integer,
      false::boolean,
      false::boolean,
      false::boolean;
    return;
  end if;

  return query select
    coalesce(v_row.tier, 'free')::text,
    coalesce(v_row.subscription_status, 'none')::text,
    coalesce(v_row.period_consumed_cents, 0)::integer,
    coalesce(v_row.period_billed_cents, 0)::integer,
    greatest(v_free_limit - coalesce(v_row.period_billed_cents, 0), 0)::integer,
    (v_row.subscription_status in ('active', 'trialing'))::boolean,
    (
      v_row.tier <> 'admin'
      and v_row.tier <> 'payg'
      and v_row.subscription_status not in ('active', 'trialing')
      and coalesce(v_row.period_billed_cents, 0) >= v_free_limit
    )::boolean,
    (v_row.tier = 'admin')::boolean;
end;
$$;

grant execute on function public.veronum_my_billing_state()
  to authenticated, anon;
