/**
 * lib/analytics.js — fire-and-forget event emitter to Supabase.
 *
 * Inserts rows into public.usage_events for every meaningful action
 * the daemon performs. Privacy: only metadata (event_type, editor,
 * mode, page) — chat content is never logged. Failures are swallowed
 * so analytics can't break user-facing flows.
 *
 * Schema mirrors lib/admin/migration: { ts, user_id, install_id,
 * event_type, editor, mode, page, app_version, metadata }.
 */

"use strict";

const bridgeSupabase = require("./bridgeSupabase");

let APP_VERSION = null;
try { APP_VERSION = require("../package.json").version; } catch { /* ignore */ }

/**
 * Emit an event. Never throws. Returns a Promise the caller can ignore.
 *
 *   emit("dispatch_sent", { editor: "claude", mode: "chat" })
 *   emit("terminal_opened")
 *   emit("voice_started", { editor: "claude" })
 *   emit("conversation_started", { editor: "cursor" })
 */
async function emit(eventType, fields = {}) {
  try {
    const supabase = bridgeSupabase.getSupabaseClient?.();
    if (!supabase) return; // bridge not initialized (local-only mode)
    const row = {
      event_type: String(eventType),
      user_id: bridgeSupabase.getUserId?.() || null,
      install_id: bridgeSupabase.getInstallId?.() || null,
      editor: fields.editor || null,
      mode: fields.mode || null,
      page: fields.page || null,
      app_version: APP_VERSION,
      metadata: fields.metadata ? fields.metadata : null,
    };
    // Insert via PostgREST. RLS on the table allows anon inserts so the
    // publishable key is enough.
    await supabase.from("usage_events").insert(row);
  } catch {
    /* analytics must never break a user-facing flow */
  }
}

module.exports = { emit };
