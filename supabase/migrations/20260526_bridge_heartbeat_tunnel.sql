-- 20260526_bridge_heartbeat_tunnel.sql
-- Extend the daemon's heartbeat RPC to also publish the current
-- cloudflared trycloudflare.com tunnel URL. Without this, the URL gets
-- hand-populated once and goes stale as soon as cloudflared restarts —
-- which is what bit us with the 530 "origin unregistered from Argo
-- Tunnel" on mobile while localhost on the Mac kept working.
--
-- The daemon's lib/bridgeCloudflared.js spawns cloudflared, parses its
-- stderr for the URL, and pipes it through to this RPC on every poll
-- (and immediately on any URL change).
--
-- COALESCE keeps the existing URL when the daemon calls without one
-- (e.g. cloudflared not started yet). The tunnel_url_updated_at column
-- only moves when the URL actually changes — useful for debugging and
-- for the future "your Mac dropped offline N minutes ago" UI.
--
-- SECURITY DEFINER so the anon-key daemon can call it; the RPC is
-- keyed by install_id (a server-minted UUIDv4 living only on disk) so
-- the implicit auth is "knows my install_id". Same trust model as
-- /begin-pair and /status.

drop function if exists public.veronum_bridge_heartbeat(text);

create or replace function public.veronum_bridge_heartbeat(
  p_install_id text,
  p_tunnel_url text default null
)
returns void
language sql
security definer
set search_path to 'public'
as $$
  update public.veronum_bridges
  set
    last_seen_at = now(),
    tunnel_url = coalesce(p_tunnel_url, tunnel_url),
    tunnel_url_updated_at = case
      when p_tunnel_url is not null
        and p_tunnel_url is distinct from tunnel_url
      then now()
      else tunnel_url_updated_at
    end
  where install_id = p_install_id
    and user_id is not null;
$$;

grant execute on function public.veronum_bridge_heartbeat(text, text)
  to anon, authenticated, service_role;
