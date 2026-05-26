# Bridge — Supabase schema + edge function

This directory holds the database migration and edge function that
make the Veronum Bridge daemon connect to the existing Supabase
project (`synpjcammfjebwsmtfpz`).

## What's here

```
migrations/
  20260526_bridge_devices.sql    Schema for veronum_bridges +
                                 veronum_bridge_dispatches, plus the
                                 RPCs the edge function calls.

functions/
  veronum-bridge/index.ts        Path-routed edge function:
                                 /begin-pair  /complete-pair  /status
                                 /unpair      (mirrors veronum-stripe).
```

## Architecture

The bridge daemon never connects to a custom WebSocket server. Instead,
once paired it joins a Supabase Realtime broadcast channel:

```
bridge:<install_id>
```

Where `install_id` is a UUIDv4 the daemon generates on first launch
and stores in the macOS keychain. Channel name is unguessable; the
web client discovers it by reading `veronum_bridges.install_id` from
the user's row (RLS-gated to the owning user).

## Apply

```bash
# Link this repo to the live project (one-time per dev machine).
supabase link --project-ref synpjcammfjebwsmtfpz

# Push the new migration.
supabase db push

# Deploy the edge function. --no-verify-jwt because /begin-pair and
# /status are called by the unpaired daemon (no JWT yet); the handlers
# verify the auth bearer themselves where required.
supabase functions deploy veronum-bridge --no-verify-jwt
```

## Endpoints

All under `https://synpjcammfjebwsmtfpz.supabase.co/functions/v1/veronum-bridge/`:

| Path             | Auth          | Called by | Notes |
|------------------|---------------|-----------|-------|
| `/begin-pair`    | none          | daemon    | mints pair_code, returns pair_url |
| `/complete-pair` | Supabase JWT  | browser   | binds the bridge to the signed-in user |
| `/status`        | none          | daemon    | polled every ~30s, doubles as heartbeat |
| `/unpair`        | Supabase JWT  | browser   | user-initiated device revocation |

## Pair flow

```
1. Daemon launches first time, generates install_id (UUIDv4) → keychain.
2. Daemon POSTs /begin-pair  { install_id }  →  { pair_code, pair_url }.
3. Daemon opens browser at:
     https://www.thetoolswebsite.com/pair-bridge?code=ABC123
4. Browser is signed in (existing AuthService session). The pair page
   reads the code, POSTs /complete-pair  { pair_code } with the user's
   Supabase JWT in the Authorization header.
5. Edge function calls the veronum_bridge_complete_pair RPC which
   atomically sets user_id, paired_at, and clears pair_code.
6. Daemon's next /status call sees paired=true + the user_id, and
   joins the Realtime channel `bridge:<install_id>` to receive
   dispatch requests from the browser.
```

## Channel protocol (post-pair)

Both the daemon and browser join `bridge:<install_id>` as broadcast
subscribers. Message envelope:

```ts
{
  type: 'dispatch.request' | 'dispatch.delta' | 'dispatch.done'
      | 'voice.token'      | 'files.tree'     | 'preview.detect',
  request_id: string,        // browser-generated, daemon echoes on each delta
  payload: { ... }           // type-specific
}
```

Daemon usage:
- `dispatch.request` → spawn `claude --resume` / `cursor-agent`
- Stream `dispatch.delta` (text, tool_use, tool_result) chunks
- Final `dispatch.done` with raw_cost_cents → also INSERTs into
  `veronum_bridge_dispatches` for billing

The protocol is intentionally close to the SSE event stream that
`/api/claude/send` already produces in the localhost-mode daemon —
makes the cloud-mode refactor incremental.
