/**
 * Client logic for the Veronum chat localhost.
 *
 * Same flow as the overlay: pick a project → pick a session → see full
 * chat → type → response streams back. Three differences from the
 * overlay's IPC-driven Electron renderer:
 *   1. fetch() instead of ipcRenderer.invoke()
 *   2. EventSource SSE instead of senderWebContents.send for streaming
 *   3. No persistence layer — refresh re-pulls from disk
 */

const els = {
  status: document.getElementById("status"),
  claudeList: document.querySelector("#claude-projects ul"),
  cursorList: document.querySelector("#cursor-projects ul"),
  projectLabel: document.getElementById("project-label"),
  sessionsList: document.querySelector("#sessions ul"),
  chatTitle: document.getElementById("chat-title"),
  messages: document.getElementById("messages"),
  composer: document.getElementById("composer"),
  composerInput: document.getElementById("composer-input"),
  sendBtn: document.getElementById("send-btn"),
  dispatchStatus: document.getElementById("dispatch-status"),
  refreshBtn: document.getElementById("refresh-btn"),
  modelSelect: document.getElementById("model-select"),
  effortSelect: document.getElementById("effort-select"),
  effortWrap: document.getElementById("effort-wrap"),
  // Mobile-first redesign additions
  drawer: document.getElementById("drawer"),
  drawerBtn: document.getElementById("drawer-btn"),
  drawerBack: document.getElementById("drawer-back"),
  drawerClose: document.getElementById("drawer-close"),
  drawerBackdrop: document.getElementById("drawer-backdrop"),
  drawerSearch: document.getElementById("drawer-search"),
  drawerTitle: document.getElementById("drawer-title"),
  drawerSubtitle: document.getElementById("drawer-subtitle"),
  sessionPill: document.getElementById("session-pill"),
  voiceBar: document.getElementById("voice-bar"),
};

// ─── Drawer: mobile slide-in, desktop pinned ────────────────────
// On mobile (< 1024px) the drawer is hidden by default. Hamburger
// or session pill opens it. Picking a session auto-closes it. On
// desktop the CSS makes it always visible and ignores .open.
const DESKTOP_MQ = window.matchMedia("(min-width: 1024px)");
function openDrawer() {
  if (DESKTOP_MQ.matches) return;
  els.drawer?.classList.add("open");
  els.drawerBackdrop?.classList.add("open");
  if (els.drawerBackdrop) els.drawerBackdrop.hidden = false;
}
function closeDrawer() {
  els.drawer?.classList.remove("open");
  els.drawerBackdrop?.classList.remove("open");
  // Use a tiny delay before hidden so the transition can play
  setTimeout(() => {
    if (els.drawerBackdrop && !els.drawerBackdrop.classList.contains("open")) {
      els.drawerBackdrop.hidden = true;
    }
  }, 260);
}
// Drawer has two views — 'projects' and 'sessions'. Switching between
// them animates the back-arrow + title. Opening the drawer always
// resets to 'projects' so the user starts at the top of the navigation
// stack (matches mobile-app expectations).
function setDrawerView(view, opts = {}) {
  if (!els.drawer) return;
  els.drawer.setAttribute("data-view", view);
  if (view === "projects") {
    els.drawerTitle.textContent = "Dylan";
    els.drawerSubtitle.textContent = "Veronum · localhost";
  } else if (view === "sessions") {
    els.drawerTitle.textContent = opts.projectLabel || "Sessions";
    els.drawerSubtitle.textContent = opts.editor
      ? `${opts.editor} · ${short(opts.cwd || "")}`
      : "";
  }
  // Reset search to avoid filtering the new view with the old query
  if (els.drawerSearch) els.drawerSearch.value = "";
  document.querySelectorAll("#drawer .drawer-section li").forEach((li) => {
    li.style.display = "";
  });
}
els.drawerBtn?.addEventListener("click", openDrawer);
els.sessionPill?.addEventListener("click", openDrawer);
els.drawerClose?.addEventListener("click", closeDrawer);
els.drawerBackdrop?.addEventListener("click", closeDrawer);
els.drawerBack?.addEventListener("click", () => setDrawerView("projects"));

// ─── Drawer search: client-side filter over project + session lists.
els.drawerSearch?.addEventListener("input", () => {
  const q = els.drawerSearch.value.trim().toLowerCase();
  const apply = (li) => {
    const text = li.textContent.toLowerCase();
    li.style.display = !q || text.includes(q) ? "" : "none";
  };
  document.querySelectorAll("#drawer .drawer-section li").forEach(apply);
});

const state = {
  editor: null,           // 'claude' | 'cursor'
  project: null,          // { cwd, label, sessionCount }
  sessionId: null,
  dispatching: false,
  claudeModels: null,     // { models: [...], efforts: [...] }
  cursorModels: null,     // ['auto', 'claude-4.5-sonnet', ...]
};

// ─── Load model lists ────────────────────────────────────────────
async function loadModels() {
  try {
    const [claude, cursor] = await Promise.all([
      fetch("/api/claude/models").then((r) => r.json()).catch(() => ({ ok: false })),
      fetch("/api/cursor/models").then((r) => r.json()).catch(() => ({ ok: false })),
    ]);
    if (claude.ok) state.claudeModels = claude;
    if (cursor.ok) state.cursorModels = cursor.models;
  } catch {/* tolerate */}
}
// Hardcoded fallbacks so the dropdowns are NEVER empty, even if
// /api/claude/models or /api/cursor/models hasn't loaded yet (the
// cursor-agent --list-models probe can take ~10s on first call).
const CLAUDE_MODEL_FALLBACK = {
  models: [
    { short: "opus",   label: "Opus 4.7 — best quality" },
    { short: "sonnet", label: "Sonnet 4.7 — balanced" },
    { short: "haiku",  label: "Haiku 4.5 — fastest" },
  ],
  efforts: [
    { value: "max",    label: "Max — deepest thinking" },
    { value: "high",   label: "High" },
    { value: "medium", label: "Medium" },
    { value: "low",    label: "Low — quickest" },
  ],
};

function refreshModelPicker() {
  els.modelSelect.innerHTML = "";
  if (state.editor === "claude") {
    const source = state.claudeModels || CLAUDE_MODEL_FALLBACK;
    for (const m of source.models) {
      const opt = document.createElement("option");
      opt.value = m.short; opt.textContent = m.label;
      els.modelSelect.appendChild(opt);
    }
    els.modelSelect.value = "opus";
    // Effort dropdown
    els.effortSelect.innerHTML = "";
    for (const e of source.efforts) {
      const opt = document.createElement("option");
      opt.value = e.value; opt.textContent = e.label;
      els.effortSelect.appendChild(opt);
    }
    els.effortSelect.value = "max";
    els.effortWrap.style.display = "";
  } else if (state.editor === "cursor") {
    const models = (state.cursorModels && state.cursorModels.length > 0)
      ? state.cursorModels
      : [{ id: "auto", label: "Auto" }];
    for (const m of models) {
      const opt = document.createElement("option");
      // Accept both shapes: {id,label} (new) or plain string (legacy)
      if (typeof m === "string") {
        opt.value = m; opt.textContent = m;
      } else {
        opt.value = m.id; opt.textContent = m.label || m.id;
      }
      els.modelSelect.appendChild(opt);
    }
    // Default to auto if available
    const hasAuto = models.some((m) => (typeof m === "string" ? m === "auto" : m.id === "auto"));
    els.modelSelect.value = hasAuto ? "auto" : (typeof models[0] === "string" ? models[0] : models[0].id);
    // Cursor doesn't have effort — hide
    els.effortWrap.style.display = "none";
  }
}

function setStatus(text, kind) {
  els.status.textContent = text;
  els.status.className = "status" + (kind ? " " + kind : "");
}
function fmtSize(b) {
  if (b < 1024) return b + "B";
  if (b < 1024 * 1024) return Math.round(b / 1024) + "KB";
  return (b / 1024 / 1024).toFixed(1) + "MB";
}
function fmtAge(ms) {
  const min = (Date.now() - ms) / 60000;
  if (min < 1) return "just now";
  if (min < 60) return Math.round(min) + "m";
  const h = min / 60;
  if (h < 24) return Math.round(h) + "h";
  return Math.round(h / 24) + "d";
}

// ─── Bootstrap: load project lists ───────────────────────────────
async function loadProjects() {
  setStatus("loading projects…");
  try {
    const r = await fetch("/api/projects").then((r) => r.json());
    if (!r.ok) throw new Error(r.error || "load failed");
    renderProjects("claude", r.claude || [], els.claudeList);
    renderProjects("cursor", r.cursor || [], els.cursorList);
    setStatus(`${r.claude?.length || 0} claude · ${r.cursor?.length || 0} cursor`, "ok");
  } catch (e) {
    setStatus("error: " + e.message, "err");
  }
}
function renderProjects(editor, projects, ul) {
  ul.innerHTML = "";
  for (const p of projects) {
    const li = document.createElement("li");
    li.innerHTML = `<div>${escapeHtml(p.label || p.cwd)}</div><span class="meta">${p.sessionCount || 0} sessions · ${escapeHtml(short(p.cwd))}</span>`;
    li.onclick = () => pickProject(editor, p);
    li.dataset.cwd = p.cwd;
    ul.appendChild(li);
  }
}

// ─── Pick a project → load its sessions ──────────────────────────
async function pickProject(editor, project) {
  state.editor = editor;
  state.project = project;
  state.sessionId = null;
  // Tell the workspace panel (Files tab) to re-fetch the tree for this
  // new project. Decoupled via a CustomEvent so the panel module
  // doesn't need a direct reference into this scope.
  document.dispatchEvent(new CustomEvent("veronum:session-changed", { detail: { project } }));
  // Highlight in left pane
  document.querySelectorAll("#projects li").forEach((el) => el.classList.remove("active"));
  document
    .querySelector(`#${editor}-projects li[data-cwd="${cssEscape(project.cwd)}"]`)
    ?.classList.add("active");

  els.projectLabel.textContent = "in " + (project.label || project.cwd);
  els.sessionsList.innerHTML = `<li class="dim">loading…</li>`;
  els.chatTitle.textContent = "Pick a session";
  els.messages.innerHTML = "";
  els.composer.hidden = true;
  refreshModelPicker();
  // Switch the drawer to its sessions view so the user sees ONLY this
  // project's sessions next. The back arrow returns to the projects
  // list. Title shows the project name; subtitle shows the cwd.
  setDrawerView("sessions", {
    projectLabel: project.label || project.cwd,
    editor,
    cwd: project.cwd,
  });

  try {
    const url =
      editor === "claude"
        ? `/api/claude/sessions?cwd=${encodeURIComponent(project.cwd)}`
        : `/api/cursor/sessions?cwd=${encodeURIComponent(project.cwd)}`;
    const r = await fetch(url).then((r) => r.json());
    if (!r.ok) throw new Error(r.error);
    renderSessions(editor, r.sessions);
  } catch (e) {
    els.sessionsList.innerHTML = `<li class="dim">error: ${escapeHtml(e.message)}</li>`;
  }
}

function renderSessions(editor, sessions) {
  els.sessionsList.innerHTML = "";
  if (!sessions || sessions.length === 0) {
    els.sessionsList.innerHTML = `<li class="dim">no sessions</li>`;
    return;
  }
  for (const s of sessions) {
    const li = document.createElement("li");
    const id = s.sessionId || s.chatId;
    const sizeStr = s.size != null ? fmtSize(s.size) : "";
    const ageStr = s.mtimeMs ? fmtAge(s.mtimeMs) : "";
    li.innerHTML = `<div>${escapeHtml(id.slice(0, 8))}…</div><span class="meta">${sizeStr} · ${ageStr}</span>`;
    li.onclick = () => pickSession(id);
    li.dataset.sid = id;
    els.sessionsList.appendChild(li);
  }
}

// ─── Pick a session → load + render the full chat ────────────────
// Two callers: (1) user clicks a session in the sidebar — we want a
// "loading…" placeholder so they see something happening; (2) the
// SSE `done` event auto-refreshes — we MUST NOT wipe the current
// chat before the fetch resolves, because if the fetch fails the
// list stays empty and the user thinks their messages were deleted.
//
// `opts.preserve`: when true (auto-refresh path), keep the current
// list visible until the new one is ready. Only swap on success.
async function pickSession(sessionId, opts = {}) {
  state.sessionId = sessionId;
  document.querySelectorAll("#sessions li").forEach((el) => el.classList.remove("active"));
  document.querySelector(`#sessions li[data-sid="${cssEscape(sessionId)}"]`)?.classList.add("active");

  // Mobile: close the drawer so the chat is visible. No-op on desktop.
  if (!opts.preserve) closeDrawer();

  els.refreshBtn.hidden = false;
  const started = Date.now();
  if (!opts.preserve) {
    els.chatTitle.textContent = "loading chat…";
    els.messages.innerHTML = "";
    setStatus("loading chat…");
  } else {
    setStatus("refreshing…");
  }

  try {
    const url =
      state.editor === "claude"
        ? `/api/claude/session?cwd=${encodeURIComponent(state.project.cwd)}&sid=${encodeURIComponent(sessionId)}`
        : `/api/cursor/session?cwd=${encodeURIComponent(state.project.cwd)}&sid=${encodeURIComponent(sessionId)}`;
    const r = await fetch(url).then((r) => r.json());
    if (!r.ok) throw new Error(r.error || "load failed");
    els.chatTitle.textContent = r.title || sessionId.slice(0, 12) + "…";
    renderMessages(r.messages || []);
    els.composer.hidden = false;
    setStatus(`loaded ${r.messages?.length || 0} messages in ${Date.now() - started}ms`, "ok");
  } catch (e) {
    // On preserve-mode failure, keep whatever is on screen and just
    // surface the error in the status bar. The user's messages are
    // still visible and the next refresh can try again.
    setStatus("refresh failed: " + e.message, "err");
    if (!opts.preserve) els.chatTitle.textContent = "error";
  }
}

function renderMessages(messages) {
  els.messages.innerHTML = "";
  for (const m of messages) appendMessage(m);
  els.messages.scrollTop = els.messages.scrollHeight;
}
function appendMessage(m, opts = {}) {
  const div = document.createElement("div");
  div.className = "msg " + (m.role || "assistant") + (opts.streaming ? " streaming" : "");
  div.innerHTML = `<div class="role">${escapeHtml(m.role || "assistant")}</div><div class="body">${escapeHtml(m.text || "")}</div>`;
  els.messages.appendChild(div);
  if (opts.streaming) return div;
  els.messages.scrollTop = els.messages.scrollHeight;
  return div;
}

// ─── Dispatch (SSE-streamed) ─────────────────────────────────────
els.composer.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (state.dispatching) return;
  const text = els.composerInput.value.trim();
  if (!text) return;
  if (!state.editor || !state.project || !state.sessionId) {
    setStatus("pick a session first", "err");
    return;
  }
  state.dispatching = true;
  els.sendBtn.disabled = true;
  els.dispatchStatus.textContent = "sending…";

  // Optimistic user bubble + streaming assistant placeholder
  appendMessage({ role: "user", text });
  els.composerInput.value = "";
  const streamEl = appendMessage({ role: "assistant", text: "" }, { streaming: true });
  const bodyEl = streamEl.querySelector(".body");
  // Visible loading status INSIDE the assistant bubble so user sees
  // progress, not silence. The bodyEl gets replaced by real text on
  // the first delta.
  bodyEl.innerHTML = `<span class="loading">⏳ Starting Claude…</span>`;
  els.messages.scrollTop = els.messages.scrollHeight;

  try {
    await streamDispatch(text, bodyEl);
    streamEl.classList.remove("streaming");
    els.dispatchStatus.textContent = "done";
    setStatus("done", "ok");
  } catch (err) {
    streamEl.classList.remove("streaming");
    bodyEl.innerHTML = `<span class="error-msg">⚠ ${escapeHtml(err.message)}</span>`;
    els.dispatchStatus.textContent = "error";
    setStatus("error: " + err.message, "err");
  } finally {
    state.dispatching = false;
    els.sendBtn.disabled = false;
  }
});

// Enter to send, shift+enter for newline
els.composerInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    els.composer.requestSubmit();
  }
});

// Send button disabled state + textarea auto-grow. Visual feedback:
// while there's no text, send is muted; once you type, it turns
// purple and is reachable. The auto-grow keeps the input feeling
// chat-like (one line at rest, expands as you type).
function syncComposer() {
  const has = els.composerInput.value.trim().length > 0;
  if (els.sendBtn) els.sendBtn.disabled = !has || state.dispatching;
  // Auto-grow textarea up to its max-height. Reset to 'auto' to let
  // scrollHeight reflect the actual content height.
  els.composerInput.style.height = "auto";
  const next = Math.min(els.composerInput.scrollHeight, 160);
  els.composerInput.style.height = next + "px";
}
els.composerInput.addEventListener("input", syncComposer);
els.composer.addEventListener("submit", () => {
  // After submit handler clears the textarea, sync to disable + shrink.
  setTimeout(syncComposer, 0);
});
syncComposer();

// fetch + SSE: POST returns a text/event-stream, we read it incrementally
async function streamDispatch(prompt, bodyEl) {
  const url = state.editor === "claude" ? "/api/claude/send" : "/api/cursor/send";
  const body = {
    cwd: state.project.cwd,
    sessionId: state.sessionId,
    prompt,
    model: els.modelSelect.value || undefined,
  };
  if (state.editor === "claude") body.effort = els.effortSelect.value || undefined;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    // Try to surface server's "detail" message verbatim — covers
    // session-busy ("Claude Desktop has this session open…"),
    // queue-timeout, etc. Falls back to status code.
    let detail = "", errCode = "";
    try {
      const j = await res.json();
      detail = j.detail || j.error || "";
      errCode = j.error || "";
    } catch {}
    const msg = detail || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.code = errCode;
    err.status = res.status;
    throw err;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // Parse SSE events ("event: name\ndata: json\n\n")
    const parts = buffer.split("\n\n");
    buffer = parts.pop() || "";
    for (const block of parts) {
      const lines = block.split("\n");
      let event = "message", data = "";
      for (const ln of lines) {
        if (ln.startsWith("event: ")) event = ln.slice(7).trim();
        else if (ln.startsWith("data: ")) data += ln.slice(6);
      }
      if (!data) continue;
      let payload;
      try { payload = JSON.parse(data); } catch { continue; }
      onSseEvent(event, payload, bodyEl);
    }
  }
}

function onSseEvent(event, payload, bodyEl) {
  // Helper: is the body currently still showing the loading placeholder?
  const isLoadingState = () =>
    bodyEl.querySelector(".loading") !== null && !bodyEl.querySelector(".real-text");

  if (event === "status") {
    els.dispatchStatus.textContent = payload.phase || "running";
    // Surface the detail message INSIDE the assistant bubble while we
    // wait. Keeps it visible right where the response will appear.
    if (isLoadingState() && payload.detail) {
      bodyEl.innerHTML = `<span class="loading">⏳ ${escapeHtml(payload.detail)}</span>`;
    }
  } else if (event === "delta") {
    // First real text — replace the loading placeholder with a text node
    // we can keep appending to.
    if (isLoadingState()) {
      bodyEl.innerHTML = `<span class="real-text"></span>`;
    }
    const realText = bodyEl.querySelector(".real-text") || bodyEl;
    if (typeof payload.accumulated === "string") {
      realText.textContent = payload.accumulated;
    } else if (typeof payload.text === "string") {
      realText.textContent += payload.text;
    }
    els.messages.scrollTop = els.messages.scrollHeight;
    els.dispatchStatus.textContent = `streaming · ${realText.textContent.length}ch`;
  } else if (event === "tool_use") {
    els.dispatchStatus.textContent = `tool: ${payload.name}`;
    if (isLoadingState()) {
      bodyEl.innerHTML = `<span class="loading">🔧 Claude is using tool: ${escapeHtml(payload.name)}</span>`;
    }
  } else if (event === "stderr") {
    console.warn("[stderr]", payload.text);
  } else if (event === "result") {
    if (payload.is_error) {
      const realText = bodyEl.querySelector(".real-text") || bodyEl;
      realText.textContent += "\n\n[error from agent: " + (payload.subtype || "unknown") + "]";
    }
    els.dispatchStatus.textContent = "result received";
  } else if (event === "error") {
    bodyEl.innerHTML = `<span class="error-msg">⚠ ${escapeHtml(payload.message)}</span>`;
  } else if (event === "done") {
    // Final flush: if streaming never produced text (e.g. claude exited
    // with no assistant output), show whatever accumulated text we have
    // or a clear "no response" marker.
    if (isLoadingState()) {
      if (payload.accumulated && payload.accumulated.trim()) {
        bodyEl.innerHTML = `<span class="real-text"></span>`;
        bodyEl.querySelector(".real-text").textContent = payload.accumulated;
      } else {
        const durSec = Math.round((payload.durationMs || 0) / 1000);
        bodyEl.innerHTML = `<span class="error-msg">⚠ Claude exited (code ${payload.code}) after ${durSec}s with no response.</span>`;
      }
    }
    // Auto-refresh: re-pull from JSONL so the chat reflects the new
    // turn(s) Claude wrote to disk. This is the safety net for the
    // case where SSE delivered the deltas fine — we still want the
    // canonical history shown (handles future scrollback, tool-use
    // turns we filtered, etc.).
    if (state.sessionId) {
      // Defer slightly so the bubble's final text stays visible briefly
      // before we replace the whole list with the JSONL view.
      // preserve:true → if the re-fetch fails, keep current messages
      // visible instead of wiping the chat.
      setTimeout(() => {
        if (state.sessionId) pickSession(state.sessionId, { preserve: true });
      }, 600);
    }
  }
}

// Refresh button — re-fetches the chat from disk
els.refreshBtn.addEventListener("click", () => {
  if (state.sessionId) pickSession(state.sessionId);
});

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function cssEscape(s) {
  return String(s || "").replace(/(["\\])/g, "\\$1");
}
function short(p) {
  return p.replace(/^\/Users\/[^/]+/, "~");
}

// Load models in parallel with projects so dropdowns are ready when
// the user picks a session.
loadModels();
loadProjects();

// ─── Voice: Companion (OpenAI Realtime) + PTT (gpt-4o-transcribe) ──
//
// Two pipelines that share the mic but never both at once.
//
// COMPANION:
//   Always-on WebRTC session to OpenAI Realtime once the user clicks
//   the mic to enable voice mode. Free-flow chat ("what's Claude
//   doing right now", "look this up", etc.) — fed live updates of
//   what Claude is doing via the data channel.
//
// PTT:
//   Holding the mic DOES NOT route to the Companion. We (a) cancel
//   any in-flight Companion response, (b) mute its mic input, (c)
//   start a local MediaRecorder, (d) on release transcribe via
//   /api/voice/transcribe and submit to Claude through the existing
//   /api/claude/send path.
//
// AUTO-SUMMARY:
//   When Claude finishes, we mark a pending summary. We wait for the
//   Companion's response.done (idle) before injecting the summary
//   request. If the user starts speaking before that fires, the
//   pending summary is dropped.

const micBtn = document.getElementById("mic-btn");
const voiceStopBtn = document.getElementById("voice-stop-btn");
const voiceStatus = document.getElementById("voice-status");

const voice = {
  enabled: false,
  starting: false,
  pc: null, dc: null, remoteAudio: null,
  micStream: null, micSender: null,
  recorder: null, pttChunks: [], holding: false,
  companionSpeaking: false, pendingSummary: null,
  pinnedEditor: null, pinnedCwd: null, pinnedSid: null,
};

function setVoiceStatus(text, kind) {
  if (!voiceStatus) return;
  voiceStatus.hidden = !text;
  voiceStatus.textContent = text || "";
  voiceStatus.className = "voice-status" + (kind ? " " + kind : "");
}
function setMicClass(cls) {
  micBtn.classList.remove("ready", "listening", "speaking", "connecting");
  if (cls) micBtn.classList.add(cls);
  // Mirror the same state on the thin voice bar at the top of the chat
  // so the user has peripheral awareness of voice activity even when
  // their eyes are on the messages. Hidden entirely when voice is off.
  const bar = els.voiceBar;
  if (!bar) return;
  bar.classList.remove("listening", "speaking");
  if (!cls) {
    bar.hidden = true;
  } else {
    bar.hidden = false;
    if (cls === "listening") bar.classList.add("listening");
    else if (cls === "speaking") bar.classList.add("speaking");
    // "ready" and "connecting" get the default purple wave.
  }
}

async function enableVoiceMode() {
  if (voice.enabled || voice.starting) return;
  if (!state.editor || !state.project || !state.sessionId) {
    setVoiceStatus("pick a session first", "err");
    return;
  }
  voice.starting = true;
  micBtn.disabled = true;
  setMicClass("connecting");
  setVoiceStatus("starting voice mode…");
  try {
    const tok = await fetch("/api/voice/realtime-token").then((r) => r.json());
    if (!tok.ok || !tok.clientSecret) {
      throw new Error(tok.error || tok.detail || "no client_secret");
    }
    setVoiceStatus("requesting microphone…");
    voice.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    voice.pc = new RTCPeerConnection();
    voice.remoteAudio = document.createElement("audio");
    voice.remoteAudio.autoplay = true;
    document.body.appendChild(voice.remoteAudio);
    voice.pc.ontrack = (ev) => { voice.remoteAudio.srcObject = ev.streams[0]; };
    const track = voice.micStream.getAudioTracks()[0];
    voice.micSender = voice.pc.addTrack(track, voice.micStream);
    voice.dc = voice.pc.createDataChannel("oai-events");
    voice.dc.addEventListener("message", (ev) => {
      try { onRealtimeEvent(JSON.parse(ev.data)); } catch (e) { console.warn("[voice] bad event", e); }
    });
    voice.dc.addEventListener("open", () => {
      console.log("[voice] data channel open");
      pinSessionToCompanion();
      pushSessionContextToCompanion();
    });
    const offer = await voice.pc.createOffer();
    await voice.pc.setLocalDescription(offer);
    // GA SDP exchange endpoint is /v1/realtime/calls (the bare
    // /v1/realtime path was the beta and is rejected with
    // beta_api_shape_disallowed). Same body (raw SDP), same Bearer
    // auth with the ephemeral key.
    const sdpResp = await fetch(
      `https://api.openai.com/v1/realtime/calls?model=${encodeURIComponent(tok.model)}`,
      { method: "POST", headers: { Authorization: `Bearer ${tok.clientSecret}`, "Content-Type": "application/sdp" }, body: offer.sdp },
    );
    if (!sdpResp.ok) {
      const t = await sdpResp.text();
      throw new Error(`realtime SDP exchange failed (${sdpResp.status}): ${t.slice(0, 200)}`);
    }
    const answerSdp = await sdpResp.text();
    await voice.pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
    voice.enabled = true;
    setMicClass("ready");
    if (voiceStopBtn) voiceStopBtn.hidden = false;
    setVoiceStatus("voice ready · hold mic to talk to Claude · just speak to talk to assistant · ✕ to stop", "ok");
  } catch (e) {
    console.error("[voice] enable failed", e);
    setVoiceStatus("voice enable failed: " + e.message, "err");
    setMicClass(null);
    teardownVoice();
  } finally {
    voice.starting = false;
    micBtn.disabled = false;
  }
}

function teardownVoice() {
  try { voice.dc?.close(); } catch {}
  try { voice.pc?.close(); } catch {}
  try { voice.micStream?.getTracks().forEach((t) => t.stop()); } catch {}
  try { voice.recorder?.stop(); } catch {}
  if (voice.remoteAudio) { try { voice.remoteAudio.remove(); } catch {} }
  voice.dc = null; voice.pc = null; voice.micStream = null; voice.micSender = null;
  voice.remoteAudio = null; voice.recorder = null; voice.pttChunks = [];
  voice.enabled = false; voice.companionSpeaking = false; voice.pendingSummary = null;
  voice.holding = false;
  if (voiceStopBtn) voiceStopBtn.hidden = true;
  setMicClass(null);
}

// User clicked the ✕ button — fully disable voice mode. The mic
// track gets stopped (browser shows the recording indicator turning
// off), the WebRTC session closes, the Companion mic is freed. To
// resume voice mode the user clicks 🎤 again, which re-prompts for
// mic permission and re-opens a fresh Realtime session.
function disableVoiceMode() {
  if (!voice.enabled && !voice.starting) return;
  teardownVoice();
  setVoiceStatus("voice off · click 🎤 to re-enable", null);
}
voiceStopBtn?.addEventListener("click", disableVoiceMode);

function pinSessionToCompanion() {
  voice.pinnedEditor = state.editor;
  voice.pinnedCwd = state.project?.cwd;
  voice.pinnedSid = state.sessionId;
}

function pushSessionContextToCompanion() {
  if (!voice.dc || voice.dc.readyState !== "open") return;
  const lines = [
    `Current session: ${state.editor} @ ${state.project?.cwd}`,
    `Session id: ${state.sessionId}`,
  ];
  const recent = Array.from(document.querySelectorAll("#messages .msg")).slice(-6);
  if (recent.length) {
    lines.push("Recent messages:");
    for (const el of recent) {
      const role = el.querySelector(".role")?.textContent || "?";
      const body = (el.querySelector(".body")?.textContent || "").slice(0, 200);
      lines.push(`  [${role}] ${body}`);
    }
  }
  sendRealtimeEvent({
    type: "conversation.item.create",
    item: { type: "message", role: "system", content: [{ type: "input_text", text: lines.join("\n") }] },
  });
}

function sendRealtimeEvent(obj) {
  if (!voice.dc || voice.dc.readyState !== "open") return;
  voice.dc.send(JSON.stringify(obj));
}

function onRealtimeEvent(ev) {
  if (!ev || !ev.type) return;
  switch (ev.type) {
    case "response.audio.delta":
      voice.companionSpeaking = true;
      setMicClass(voice.holding ? "listening" : "speaking");
      break;
    case "response.done":
      voice.companionSpeaking = false;
      setMicClass(voice.holding ? "listening" : (voice.enabled ? "ready" : null));
      if (voice.pendingSummary) {
        const queued = voice.pendingSummary;
        voice.pendingSummary = null;
        announceClaudeFinished(queued);
      }
      break;
    case "input_audio_buffer.speech_started":
      voice.pendingSummary = null;
      break;
    case "response.function_call_arguments.done":
      handleToolCall(ev);
      break;
    case "error":
      // Surface the full error so we can diagnose Realtime API
      // rejections instead of seeing a useless "unknown".
      console.warn("[voice] realtime error", JSON.stringify(ev, null, 2));
      setVoiceStatus(
        "voice error: " + (ev.error?.message || ev.error?.type || ev.error?.code || JSON.stringify(ev.error || ev).slice(0, 200)),
        "err",
      );
      break;
  }
}

async function handleToolCall(ev) {
  const name = ev.name;
  let args = {};
  try { args = JSON.parse(ev.arguments || "{}"); } catch {}
  let output = "";
  try {
    if (name === "submit_to_claude") {
      output = await tool_submitToClaude(args.prompt || "");
    } else if (name === "summarize_claude_response") {
      output = tool_summarizeClaudeResponse();
    } else if (name === "query_session_history") {
      output = await tool_querySessionHistory(args);
    } else if (name === "web_search") {
      output = await tool_webSearch(args.query || "");
    } else {
      output = `unknown tool: ${name}`;
    }
  } catch (e) {
    output = "tool error: " + e.message;
  }
  sendRealtimeEvent({
    type: "conversation.item.create",
    item: {
      type: "function_call_output",
      call_id: ev.call_id,
      output: typeof output === "string" ? output : JSON.stringify(output),
    },
  });
  sendRealtimeEvent({ type: "response.create" });
}

async function tool_submitToClaude(prompt) {
  if (!prompt) return "no prompt provided";
  dispatchFromVoice(prompt);
  return "submitted to " + (voice.pinnedEditor || state.editor);
}
function tool_summarizeClaudeResponse() {
  const all = document.querySelectorAll("#messages .msg.assistant");
  const last = all[all.length - 1];
  if (!last) return "no Claude reply yet in this session";
  return last.querySelector(".body")?.textContent || "";
}
async function tool_querySessionHistory({ action, n, pattern }) {
  const r = await fetch("/api/voice/session-history", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      cwd: voice.pinnedCwd || state.project?.cwd,
      sessionId: voice.pinnedSid || state.sessionId,
      action, n, pattern,
    }),
  }).then((r) => r.json());
  if (!r.ok) return "history error: " + (r.error || "unknown");
  return r.result || "(empty)";
}
async function tool_webSearch(query) {
  if (!query) return "no query";
  const r = await fetch("/api/voice/web-search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  }).then((r) => r.json());
  if (!r.ok) return "search error: " + (r.error || "unknown");
  return r.answer || "(no answer)";
}

async function dispatchFromVoice(text) {
  if (!text || state.dispatching) return;
  state.dispatching = true;
  els.dispatchStatus.textContent = "sending (voice)…";
  appendMessage({ role: "user", text });
  const streamEl = appendMessage({ role: "assistant", text: "" }, { streaming: true });
  const bodyEl = streamEl.querySelector(".body");
  bodyEl.innerHTML = `<span class="loading">⏳ Starting (voice)…</span>`;
  els.messages.scrollTop = els.messages.scrollHeight;
  try {
    await streamDispatch(text, bodyEl);
    streamEl.classList.remove("streaming");
    els.dispatchStatus.textContent = "done";
    const final = (bodyEl.textContent || "").slice(0, 2000);
    if (voice.companionSpeaking) {
      voice.pendingSummary = final;
    } else {
      announceClaudeFinished(final);
    }
  } catch (err) {
    streamEl.classList.remove("streaming");
    bodyEl.innerHTML = `<span class="error-msg">⚠ ${escapeHtml(err.message)}</span>`;
    els.dispatchStatus.textContent = "error";
  } finally {
    state.dispatching = false;
  }
}

function announceClaudeFinished(text) {
  if (!voice.dc || voice.dc.readyState !== "open") return;
  if (!text) return;
  sendRealtimeEvent({
    type: "conversation.item.create",
    item: { type: "message", role: "system",
      content: [{ type: "input_text", text: `CLAUDE_FINISHED: ${text.slice(0, 1800)}` }] },
  });
  sendRealtimeEvent({
    type: "response.create",
    // GA Realtime removed `modalities` from response.create — passing
    // it returns "Unknown parameter: 'response.modalities'" and aborts
    // the turn. Session defaults (audio+text from /client_secrets)
    // apply automatically.
    response: {
      instructions: "Briefly summarize what Claude just did in 1-2 sentences. No greeting.",
    },
  });
}

function pttStart() {
  if (!voice.enabled) { enableVoiceMode(); return; }
  if (voice.holding) return;
  voice.holding = true;
  try { sendRealtimeEvent({ type: "response.cancel" }); } catch {}
  voice.companionSpeaking = false;
  voice.pendingSummary = null;
  try { voice.micSender?.replaceTrack(null); } catch {}
  voice.pttChunks = [];
  try {
    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";
    voice.recorder = new MediaRecorder(voice.micStream, { mimeType: mime });
    voice.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) voice.pttChunks.push(e.data);
    };
    voice.recorder.start(250);
  } catch (e) {
    console.error("[ptt] recorder start failed", e);
    setVoiceStatus("ptt start failed: " + e.message, "err");
    voice.holding = false;
    return;
  }
  setMicClass("listening");
  setVoiceStatus("listening… release to send to Claude", "ok");
}

async function pttEnd() {
  if (!voice.holding) return;
  voice.holding = false;
  try {
    const track = voice.micStream?.getAudioTracks()[0];
    if (track) await voice.micSender?.replaceTrack(track);
  } catch (e) { console.warn("[ptt] re-engage mic failed", e); }
  if (!voice.recorder) {
    setMicClass(voice.enabled ? "ready" : null);
    return;
  }
  const rec = voice.recorder;
  voice.recorder = null;
  const stopped = new Promise((resolve) => { rec.onstop = resolve; });
  try { rec.stop(); } catch {}
  await stopped;
  if (voice.pttChunks.length === 0) {
    setMicClass(voice.enabled ? "ready" : null);
    setVoiceStatus("nothing captured", "err");
    return;
  }
  setMicClass("connecting");
  setVoiceStatus("transcribing…");
  const blob = new Blob(voice.pttChunks, { type: rec.mimeType || "audio/webm" });
  voice.pttChunks = [];
  try {
    const tr = await fetch("/api/voice/transcribe", {
      method: "POST",
      headers: { "Content-Type": blob.type },
      body: blob,
    }).then((r) => r.json());
    if (!tr.ok || !tr.text) {
      // Surface OpenAI's body verbatim so the user (or me reading
      // the screenshot) can see why it rejected the audio.
      const detail = tr.openaiBody || tr.error || "empty transcription";
      console.warn("[ptt] transcribe failed", { mime: blob.type, bytes: blob.size, response: tr });
      throw new Error(detail.slice(0, 240));
    }
    setMicClass("ready");
    setVoiceStatus(`heard: "${tr.text.slice(0, 60)}"`, "ok");
    dispatchFromVoice(tr.text);
  } catch (e) {
    setMicClass(voice.enabled ? "ready" : null);
    setVoiceStatus("transcribe failed: " + e.message, "err");
  }
}

micBtn.addEventListener("mousedown", (e) => { e.preventDefault(); pttStart(); });
micBtn.addEventListener("touchstart", (e) => { e.preventDefault(); pttStart(); }, { passive: false });
micBtn.addEventListener("mouseup", (e) => { e.preventDefault(); pttEnd(); });
micBtn.addEventListener("mouseleave", () => { if (voice.holding) pttEnd(); });
micBtn.addEventListener("touchend", (e) => { e.preventDefault(); pttEnd(); }, { passive: false });
micBtn.addEventListener("touchcancel", (e) => { e.preventDefault(); pttEnd(); }, { passive: false });


// ─── Workspace panel (Files tab + Preview tab) ──────────────────────────
// Single button in the topbar opens a slide-over with two surfaces:
//
//   Files:    tree of the current session's project (state.project.cwd)
//             + code viewer with Prism syntax highlight. Default view —
//             always has SOMETHING to show.
//   Preview:  iframe proxied through /preview/<port>/ to a localhost
//             dev server (Vite/Next/CRA…). Shows when the user clicks
//             the tab AND has a dev server running.
//
// Why Files default: every Claude/Cursor session has a project dir on
// disk; opening Preview-first when there's nothing to preview surfaces
// a confusing empty state. Files always has the code from the session
// we're already chatting about.
(() => {
  const els = {
    btn: document.getElementById("preview-btn"),
    panel: document.getElementById("preview-panel"),
    close: document.getElementById("preview-close"),
    reload: document.getElementById("preview-reload"),
    tabs: document.querySelectorAll(".preview-tab"),
    bodies: document.querySelectorAll(".preview-body"),
    // Files tab
    tree: document.getElementById("files-tree"),
    viewer: document.getElementById("files-viewer"),
    // Preview tab
    portSelect: document.getElementById("preview-port"),
    previewEmpty: document.getElementById("preview-empty"),
    frameWrap: document.getElementById("preview-frame-wrap"),
    frame: document.getElementById("preview-frame"),
    vps: document.querySelectorAll(".preview-vp"),
  };
  if (!els.btn || !els.panel) return;

  let activeTab = "files";
  let activeFilePath = null;
  let prismLoading = null;

  // ─── Prism.js lazy load (only when the first file is opened) ─────────
  function ensurePrism() {
    if (window.Prism) return Promise.resolve();
    if (prismLoading) return prismLoading;
    prismLoading = new Promise((resolve) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-core.min.js";
      s.onload = () => {
        const a = document.createElement("script");
        a.src = "https://cdn.jsdelivr.net/npm/prismjs@1.29.0/plugins/autoloader/prism-autoloader.min.js";
        a.onload = () => resolve();
        a.onerror = () => resolve();
        document.body.appendChild(a);
      };
      s.onerror = () => resolve();
      document.body.appendChild(s);
    });
    return prismLoading;
  }

  // ─── Tab switching ───────────────────────────────────────────────────
  function setTab(tab) {
    activeTab = tab;
    els.panel.dataset.tab = tab;
    els.tabs.forEach((b) => {
      const on = b.dataset.tab === tab;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
    els.bodies.forEach((b) => { b.hidden = b.dataset.tab !== tab; });
    if (tab === "preview") loadPorts();
  }
  els.tabs.forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));

  // ─── Files tab ───────────────────────────────────────────────────────
  function currentCwd() {
    // state lives in the outer app.js closure — we read via the global
    // 'state' if exposed, otherwise fall back to scraping the session
    // pill (this script is appended to app.js so it shares scope).
    return (typeof state !== "undefined" && state?.project?.cwd) || null;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
  }

  // Render one level of children. Returns the <ul> element for caller
  // to insert into the tree.
  function renderEntries(entries, depth) {
    const wrap = document.createElement("div");
    wrap.className = "files-children";
    wrap.style.display = depth === 0 ? "block" : "none";
    for (const entry of entries) {
      const row = document.createElement("div");
      row.className = `files-row ${entry.type}`;
      row.style.paddingLeft = `${8 + depth * 14}px`;
      row.dataset.rel = entry.rel;
      row.dataset.type = entry.type;
      row.innerHTML = `<span class="files-row-icon"></span><span class="files-row-name">${escapeHtml(entry.name)}</span>`;
      wrap.appendChild(row);
      if (entry.type === "dir") {
        const childWrap = document.createElement("div");
        childWrap.className = "files-children";
        childWrap.dataset.rel = entry.rel;
        childWrap.dataset.loaded = "0";
        wrap.appendChild(childWrap);
      }
    }
    return wrap;
  }

  async function fetchTree(rel) {
    const cwd = currentCwd();
    if (!cwd) return null;
    const url = `/api/files/tree?cwd=${encodeURIComponent(cwd)}&rel=${encodeURIComponent(rel || ".")}`;
    const r = await fetch(url).then((x) => x.json());
    if (!r.ok) throw new Error(r.error || "tree fetch failed");
    return r.entries || [];
  }

  async function expandDir(row, childWrap) {
    if (childWrap.dataset.loaded === "1") {
      row.classList.toggle("open");
      childWrap.style.display = row.classList.contains("open") ? "block" : "none";
      return;
    }
    childWrap.innerHTML = `<div class="files-row" style="padding-left:${8 + (parseInt(row.style.paddingLeft) / 14) + 14}px"><span class="dim">loading…</span></div>`;
    childWrap.dataset.loaded = "1";
    try {
      const entries = await fetchTree(row.dataset.rel);
      childWrap.innerHTML = "";
      const sub = renderEntries(entries, (parseInt(row.style.paddingLeft) / 14));
      sub.style.display = "block";
      // Move sub's children into childWrap directly to flatten the wrapper.
      while (sub.firstChild) childWrap.appendChild(sub.firstChild);
      row.classList.add("open");
    } catch (e) {
      childWrap.innerHTML = `<div class="files-row"><span class="dim">error: ${escapeHtml(e.message)}</span></div>`;
    }
  }

  async function openFile(rel) {
    activeFilePath = rel;
    // Mark active row
    els.tree.querySelectorAll(".files-row.active").forEach((r) => r.classList.remove("active"));
    const row = els.tree.querySelector(`.files-row[data-rel="${rel.replace(/"/g, '\\"')}"]`);
    row?.classList.add("active");

    els.viewer.innerHTML = `<div class="files-empty">loading…</div>`;
    const cwd = currentCwd();
    if (!cwd) { els.viewer.innerHTML = `<div class="files-empty">No project — open a session first.</div>`; return; }
    try {
      const r = await fetch(`/api/files/read?cwd=${encodeURIComponent(cwd)}&rel=${encodeURIComponent(rel)}`).then((x) => x.json());
      if (!r.ok) {
        const msg = r.code === "EBINARY" ? "Binary file — not displayed."
          : r.code === "E2BIG"   ? "File too large to display."
          : r.error || "Failed to read file.";
        els.viewer.innerHTML = `<div class="files-empty">${escapeHtml(msg)}</div>`;
        return;
      }
      const sizeKb = (r.size / 1024).toFixed(1);
      els.viewer.innerHTML = `
        <div class="files-viewer-head">
          <span>${escapeHtml(r.filename)}</span>
          <span class="dim">${escapeHtml(r.language)} · ${sizeKb} KB</span>
        </div>
        <pre class="files-viewer-body"><code class="language-${escapeHtml(r.language)}"></code></pre>
      `;
      // Insert text content via textContent (safe) then ask Prism to highlight.
      const codeEl = els.viewer.querySelector("code");
      codeEl.textContent = r.contents;
      await ensurePrism();
      if (window.Prism) window.Prism.highlightElement(codeEl);
    } catch (e) {
      els.viewer.innerHTML = `<div class="files-empty">Error: ${escapeHtml(e.message)}</div>`;
    }
  }

  els.tree.addEventListener("click", (e) => {
    const row = e.target.closest(".files-row");
    if (!row || !els.tree.contains(row)) return;
    if (row.dataset.type === "dir") {
      const childWrap = row.nextElementSibling;
      if (childWrap && childWrap.classList.contains("files-children")) {
        expandDir(row, childWrap);
      }
    } else {
      openFile(row.dataset.rel);
    }
  });

  async function loadFilesRoot() {
    const cwd = currentCwd();
    if (!cwd) {
      els.tree.innerHTML = `<div class="files-empty">Open a session to see its project files.</div>`;
      els.viewer.innerHTML = `<div class="files-empty">No project — open a Claude or Cursor session first.</div>`;
      return;
    }
    els.tree.innerHTML = `<div class="files-empty">loading…</div>`;
    try {
      const entries = await fetchTree(".");
      if (!entries || entries.length === 0) {
        els.tree.innerHTML = `<div class="files-empty">Empty project directory.</div>`;
        return;
      }
      els.tree.innerHTML = "";
      const root = renderEntries(entries, 0);
      root.style.display = "block";
      while (root.firstChild) els.tree.appendChild(root.firstChild);

      // Auto-open a sensible default file so the viewer isn't a blank
      // "Pick a file…" prompt on first open. Priority:
      //   README.md > README > package.json > tsconfig.json > first file
      const PICK_ORDER = ["README.md", "README", "readme.md", "package.json", "tsconfig.json"];
      const fileEntries = entries.filter((e) => e.type === "file");
      let defaultFile = PICK_ORDER
        .map((name) => fileEntries.find((e) => e.name === name))
        .find(Boolean);
      if (!defaultFile) {
        // Fallback: pick the first text-looking file (has a dot extension).
        defaultFile = fileEntries.find((e) => e.name.includes("."));
      }
      if (defaultFile) {
        // Don't await — let the tree render first, then the viewer fills in.
        openFile(defaultFile.rel);
      }
    } catch (e) {
      els.tree.innerHTML = `<div class="files-empty">Couldn't load tree: ${escapeHtml(e.message)}</div>`;
    }
  }

  // ─── Preview tab (dev server iframe) ─────────────────────────────────
  const PRIORITY = [5173, 3000, 8080, 4321, 5000, 8000, 4200, 1234, 9000];
  function rankPort(p) {
    const idx = PRIORITY.indexOf(p);
    return idx === -1 ? PRIORITY.length + p : idx;
  }
  async function loadPorts() {
    els.portSelect.innerHTML = `<option value="">loading…</option>`;
    try {
      const r = await fetch("/api/preview/ports").then((x) => x.json());
      const ports = (r?.ports || []).slice().sort(
        (a, b) => rankPort(a.port) - rankPort(b.port),
      );
      if (ports.length === 0) {
        els.portSelect.innerHTML = `<option value="">no dev servers detected</option>`;
        showPreviewEmpty();
        return;
      }
      els.portSelect.innerHTML = ports
        .map((p) => `<option value="${p.port}">${p.port} · ${p.command}</option>`)
        .join("");
      if (!els.portSelect.value) {
        els.portSelect.value = String(ports[0].port);
        loadIntoFrame(ports[0].port);
      }
    } catch (e) {
      els.portSelect.innerHTML = `<option value="">discovery failed</option>`;
      showPreviewEmpty();
    }
  }
  function showPreviewEmpty() {
    els.previewEmpty.hidden = false;
    els.frameWrap.hidden = true;
    els.frame.src = "about:blank";
  }
  function loadIntoFrame(port) {
    if (!port) return showPreviewEmpty();
    els.previewEmpty.hidden = true;
    els.frameWrap.hidden = false;
    els.frame.src = `/preview/${port}/`;
  }
  function setViewport(vp) {
    els.frameWrap.dataset.vp = vp;
    els.vps.forEach((b) => b.classList.toggle("active", b.dataset.vp === vp));
  }
  els.portSelect?.addEventListener("change", () => loadIntoFrame(els.portSelect.value));
  els.vps.forEach((b) => b.addEventListener("click", () => setViewport(b.dataset.vp)));

  // ─── Panel open/close ────────────────────────────────────────────────
  els.btn.addEventListener("click", () => {
    const opening = els.panel.hidden;
    els.panel.hidden = !opening;
    if (opening) {
      setTab("files");
      loadFilesRoot();
    }
  });
  els.close.addEventListener("click", () => {
    els.panel.hidden = true;
    els.frame.src = "about:blank"; // stop HMR WS hammering upstream
  });
  els.reload.addEventListener("click", () => {
    if (activeTab === "files") loadFilesRoot();
    else if (els.portSelect.value) loadIntoFrame(els.portSelect.value);
  });

  // Re-load the tree when the session changes while the panel is open.
  document.addEventListener("veronum:session-changed", () => {
    if (!els.panel.hidden && activeTab === "files") loadFilesRoot();
  });

  setViewport("full");
  els.panel.dataset.tab = "files";
})();
