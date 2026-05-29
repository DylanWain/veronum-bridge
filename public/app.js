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
  vscodeList: document.querySelector("#vscode-projects ul"),
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
    renderProjects("vscode", r.vscode || [], els.vscodeList);
    setStatus(`${r.claude?.length || 0} claude · ${r.cursor?.length || 0} cursor · ${r.vscode?.length || 0} vscode`, "ok");
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

  // VS Code mode: no chat, no sessions — go straight into the
  // Files/Preview/Terminal workspace panel rooted at the project's cwd.
  if (editor === "vscode") {
    enterVscodeMode(project);
    return;
  }
  // Leaving VS Code mode (or never entered it): make sure chat chrome
  // is visible again.
  document.body.removeAttribute("data-mode");

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

// VS Code mode — no chat. Just opens the Files/Preview/Terminal panel
// rooted at the project's cwd. The chat composer + messages list are
// hidden so the workspace panel is effectively the whole window.
function enterVscodeMode(project) {
  // Synthetic session id keeps any code that reads state.sessionId happy
  // (file tree, preview, terminal all use cwd + may use sessionId for
  // the project-cwd session-scan fallback).
  state.sessionId = `vscode:${project.cwd}`;
  els.chatTitle.textContent = project.label || (project.cwd || "").split("/").pop();
  document.getElementById("status").textContent = "vscode · " + short(project.cwd);
  els.composer.hidden = true;
  els.messages.innerHTML = "";
  // Force the workspace panel open and switch to Files tab so the user
  // lands in the file tree immediately. Mark the body so CSS can hide
  // chat chrome (status bar etc) in vscode mode.
  document.body.dataset.mode = "vscode";
  const panel = document.getElementById("preview-panel");
  if (panel) panel.hidden = false;
  // Close the drawer (mobile) and hand back the file list.
  const drawer = document.getElementById("drawer");
  if (drawer) drawer.dataset.open = "false";
  const backdrop = document.getElementById("drawer-backdrop");
  if (backdrop) backdrop.hidden = true;
  // Re-load the file tree for the new cwd.
  document.dispatchEvent(new CustomEvent("veronum:session-changed", { detail: { project } }));
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
  bodyEl.innerHTML = `<span class="loading">⏳ Starting ${state.editor === "cursor" ? "Cursor" : "Claude"}…</span>`;
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
    if (err.status === 402 && window.veronumBilling) {
      window.veronumBilling.triggerPaywall(err.message);
    }
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
    const tokRes = await fetch("/api/voice/realtime-token");
    if (tokRes.status === 402) {
      const body = await tokRes.json().catch(() => ({}));
      if (window.veronumBilling) {
        window.veronumBilling.triggerPaywall(body.message || "Subscribe to use voice.");
      }
      throw new Error(body.message || "voice quota exceeded — subscribe to continue");
    }
    const tok = await tokRes.json();
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
    if (err.status === 402 && window.veronumBilling) {
      window.veronumBilling.triggerPaywall(err.message);
    }
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
    // Preview tab (canvas-based pixel stream; iframe is gone)
    portSelect: document.getElementById("preview-port"),
    previewEmpty: document.getElementById("preview-empty"),
    previewEmptyTitle: document.getElementById("preview-empty-title"),
    previewEmptyDetail: document.getElementById("preview-empty-detail"),
    previewStartDev: document.getElementById("preview-start-dev"),
    previewOpenTab: document.getElementById("preview-open-tab"),
    previewOpenRenderer: document.getElementById("preview-open-renderer"),
    previewError: document.getElementById("preview-error"),
    vps: document.querySelectorAll(".preview-vp"),
  };
  if (!els.btn || !els.panel) return;

  let activeTab = "files";
  let activeFilePath = null;
  let prismLoading = null;
  // Cwd we actually preview against. Usually equals state.project.cwd
  // (the session's literal cwd) but the server can override it when the
  // session was opened in a non-project dir (~) and the user `cd`'d
  // into a real project mid-session. Set by loadPorts() and read by
  // startDevServer() + startElectronLogPoll().
  let effectivePreviewCwd = null;

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

  // Tracks the in-memory state of the currently-open file so we can
  // detect "dirty" (unsaved changes) and prevent accidental switches
  // that would lose edits.
  let currentFile = null; // { rel, originalContents, language }

  async function openFile(rel) {
    // Confirm dropping unsaved changes if any.
    if (currentFile && isDirty() && activeFilePath !== rel) {
      const ok = window.confirm(`Discard unsaved changes to ${currentFile.rel}?`);
      if (!ok) return;
    }
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
        currentFile = null;
        return;
      }
      currentFile = { rel, originalContents: r.contents, language: r.language };
      const sizeKb = (r.size / 1024).toFixed(1);
      els.viewer.innerHTML = `
        <div class="files-viewer-head">
          <span class="files-viewer-name">${escapeHtml(r.filename)}</span>
          <span class="dim">${escapeHtml(r.language)} · ${sizeKb} KB</span>
          <span id="files-dirty" class="files-dirty" hidden>● unsaved</span>
          <span id="files-saved" class="files-saved" hidden>✓ saved</span>
          <button id="files-save-btn" class="files-save-btn" type="button" disabled>Save (⌘S)</button>
        </div>
        <textarea id="files-edit" class="files-edit" spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off"></textarea>
      `;
      const ta = els.viewer.querySelector("#files-edit");
      const saveBtn = els.viewer.querySelector("#files-save-btn");
      ta.value = r.contents;
      ta.addEventListener("input", () => {
        const dirty = isDirty();
        els.viewer.querySelector("#files-dirty").hidden = !dirty;
        els.viewer.querySelector("#files-saved").hidden = true;
        if (saveBtn) saveBtn.disabled = !dirty;
      });
      // ⌘S / Ctrl+S to save.
      ta.addEventListener("keydown", (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
          e.preventDefault();
          saveCurrentFile();
        }
        // Tab indents instead of jumping focus — feels like an editor.
        if (e.key === "Tab" && !e.shiftKey) {
          e.preventDefault();
          const start = ta.selectionStart, end = ta.selectionEnd;
          ta.value = ta.value.slice(0, start) + "  " + ta.value.slice(end);
          ta.selectionStart = ta.selectionEnd = start + 2;
          ta.dispatchEvent(new Event("input"));
        }
      });
      if (saveBtn) saveBtn.addEventListener("click", saveCurrentFile);
    } catch (e) {
      els.viewer.innerHTML = `<div class="files-empty">Error: ${escapeHtml(e.message)}</div>`;
      currentFile = null;
    }
  }

  function isDirty() {
    const ta = els.viewer?.querySelector("#files-edit");
    if (!ta || !currentFile) return false;
    return ta.value !== currentFile.originalContents;
  }

  async function saveCurrentFile() {
    const cwd = currentCwd();
    const ta = els.viewer.querySelector("#files-edit");
    if (!cwd || !currentFile || !ta) return;
    const saveBtn = els.viewer.querySelector("#files-save-btn");
    const dirtyEl = els.viewer.querySelector("#files-dirty");
    const savedEl = els.viewer.querySelector("#files-saved");
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = "Saving…"; }
    try {
      const res = await fetch("/api/files/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, rel: currentFile.rel, contents: ta.value }),
      }).then((x) => x.json());
      if (!res.ok) throw new Error(res.error || "save failed");
      currentFile.originalContents = ta.value;
      if (dirtyEl) dirtyEl.hidden = true;
      if (savedEl) {
        savedEl.hidden = false;
        setTimeout(() => { if (savedEl) savedEl.hidden = true; }, 2500);
      }
      if (saveBtn) { saveBtn.textContent = "Save (⌘S)"; saveBtn.disabled = true; }
    } catch (e) {
      if (saveBtn) { saveBtn.textContent = "Save (⌘S)"; saveBtn.disabled = false; }
      alert("Couldn't save: " + e.message);
    }
  }

  // Warn before page unload if there are unsaved edits.
  window.addEventListener("beforeunload", (e) => {
    if (isDirty()) { e.preventDefault(); e.returnValue = ""; }
  });

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

  // ─── Preview tab (pixel-streamed canvas) ─────────────────────────────
  // We replaced the old iframe-with-HTTP-proxy approach because dev
  // servers (Vite/Next/CRA) emit absolute paths that fight any path
  // rewriting we do. Instead, the daemon launches a headless Chrome on
  // the Mac pointed at the dev server URL, and streams JPEG frames
  // over a WebSocket. The dev server runs unmodified.
  const PRIORITY = [5173, 3000, 8080, 4321, 5000, 8000, 4200, 1234, 9000];
  function rankPort(p) {
    const idx = PRIORITY.indexOf(p);
    return idx === -1 ? PRIORITY.length + p : idx;
  }

  // Refs to the new canvas/stage elements (replaces frameWrap/frame).
  const stageEl = document.getElementById("preview-stage");
  const canvasEl = document.getElementById("preview-canvas");
  const statusEl = document.getElementById("preview-status");

  let previewWs = null;
  let previewWsTimer = null;
  let lastFrameW = 0;
  let lastFrameH = 0;

  function setPreviewStatus(text, autoHideMs = 0) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.dataset.visible = "1";
    if (autoHideMs) {
      clearTimeout(setPreviewStatus._t);
      setPreviewStatus._t = setTimeout(() => { statusEl.dataset.visible = "0"; }, autoHideMs);
    }
  }

  function showPreviewEmpty() {
    els.previewEmpty.hidden = false;
    if (stageEl) stageEl.hidden = true;
    closePreviewWs();
  }

  function closePreviewWs() {
    if (previewWsTimer) { clearTimeout(previewWsTimer); previewWsTimer = null; }
    if (previewWs) {
      try { previewWs.close(); } catch {}
      previewWs = null;
    }
  }

  // Render a base64 JPEG into the canvas, adjusting its intrinsic size
  // to match the frame so coordinates map 1:1 to the dev server's view.
  function paintFrame(b64) {
    const img = new Image();
    img.onload = () => {
      if (img.width !== lastFrameW || img.height !== lastFrameH) {
        canvasEl.width = img.width;
        canvasEl.height = img.height;
        lastFrameW = img.width;
        lastFrameH = img.height;
      }
      const ctx = canvasEl.getContext("2d");
      ctx.drawImage(img, 0, 0);
    };
    img.src = `data:image/jpeg;base64,${b64}`;
  }

  function openPreviewStream(port) {
    closePreviewWs();
    els.previewEmpty.hidden = true;
    if (stageEl) stageEl.hidden = false;
    setPreviewStatus("connecting…");
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `http://localhost:${port}/`;
    const wsUrl = `${protocol}//${window.location.host}/api/preview/stream?url=${encodeURIComponent(url)}`;
    const ws = new WebSocket(wsUrl);
    previewWs = ws;
    ws.onopen = () => setPreviewStatus("waiting for first frame…");
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === "frame") {
        if (statusEl.dataset.visible === "1") {
          statusEl.dataset.visible = "0";
        }
        paintFrame(msg.data);
      } else if (msg.type === "ready") {
        setPreviewStatus(`launching headless Chrome → ${msg.url}`, 4000);
      } else if (msg.type === "error") {
        setPreviewStatus(`error: ${msg.message}`);
      } else if (msg.type === "ended") {
        setPreviewStatus(`stream ended: ${msg.reason || "unknown"}`);
      }
    };
    ws.onerror = () => setPreviewStatus("connection error");
    ws.onclose = () => {
      if (previewWs === ws) {
        setPreviewStatus("disconnected — click reload to reconnect");
      }
    };
  }

  // Convert a pointer event on the canvas to JPEG-frame coordinates.
  // The canvas element is scaled by CSS to fit the panel; we map back
  // to the canvas's intrinsic pixel dimensions so the daemon clicks at
  // the right spot in the headless Chrome's viewport.
  function eventToFrameCoords(e) {
    const rect = canvasEl.getBoundingClientRect();
    const xCss = (e.clientX ?? e.touches?.[0]?.clientX ?? 0) - rect.left;
    const yCss = (e.clientY ?? e.touches?.[0]?.clientY ?? 0) - rect.top;
    const scaleX = canvasEl.width / rect.width;
    const scaleY = canvasEl.height / rect.height;
    return { x: xCss * scaleX, y: yCss * scaleY };
  }

  function sendInput(event) {
    if (!previewWs || previewWs.readyState !== WebSocket.OPEN) return;
    try { previewWs.send(JSON.stringify(event)); } catch {}
  }

  // Touch / mouse / wheel / key handlers on the canvas. These get
  // translated daemon-side into CDP Input.dispatch* calls so the
  // headless Chrome thinks a real user is interacting with it.
  if (canvasEl) {
    canvasEl.addEventListener("mousedown", (e) => {
      const { x, y } = eventToFrameCoords(e);
      sendInput({ type: "mousePressed", x, y, button: "left", clickCount: 1 });
      canvasEl.focus();
    });
    canvasEl.addEventListener("mouseup", (e) => {
      const { x, y } = eventToFrameCoords(e);
      sendInput({ type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    });
    canvasEl.addEventListener("mousemove", (e) => {
      // Throttle to avoid flooding the WS with mousemove deltas.
      if (e.buttons === 0 && !canvasEl._hoverThrottle) return;
      canvasEl._hoverThrottle = true;
      setTimeout(() => { canvasEl._hoverThrottle = false; }, 40);
      const { x, y } = eventToFrameCoords(e);
      sendInput({ type: "mouseMoved", x, y });
    });
    canvasEl.addEventListener("wheel", (e) => {
      e.preventDefault();
      const { x, y } = eventToFrameCoords(e);
      sendInput({ type: "mouseWheel", x, y, deltaX: e.deltaX, deltaY: e.deltaY });
    }, { passive: false });
    // Touch handlers (phone). Translate to mousePressed/Released so the
    // daemon doesn't need separate touch logic.
    canvasEl.addEventListener("touchstart", (e) => {
      e.preventDefault();
      const { x, y } = eventToFrameCoords(e);
      sendInput({ type: "mousePressed", x, y, button: "left", clickCount: 1 });
    }, { passive: false });
    canvasEl.addEventListener("touchend", (e) => {
      e.preventDefault();
      const t = e.changedTouches?.[0];
      const rect = canvasEl.getBoundingClientRect();
      const x = ((t?.clientX ?? 0) - rect.left) * (canvasEl.width / rect.width);
      const y = ((t?.clientY ?? 0) - rect.top) * (canvasEl.height / rect.height);
      sendInput({ type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    }, { passive: false });
    canvasEl.addEventListener("touchmove", (e) => {
      e.preventDefault();
      const { x, y } = eventToFrameCoords(e);
      sendInput({ type: "mouseMoved", x, y });
    }, { passive: false });
    canvasEl.addEventListener("keydown", (e) => {
      e.preventDefault();
      sendInput({
        type: "keyDown", key: e.key, code: e.code,
        text: e.key.length === 1 ? e.key : "",
      });
    });
    canvasEl.addEventListener("keyup", (e) => {
      e.preventDefault();
      sendInput({ type: "keyUp", key: e.key, code: e.code });
    });
  }

  // Project-aware: when the session has a cwd, check if THAT project's
  // dev server is running. If yes, preview it. If no, show a button to
  // start it. Falls back to the generic port picker if there's no cwd.
  // True when this page is being served via Veronum's cloudflared
  // tunnel (a phone, an iPad, anything not on the Mac itself). In that
  // case "http://localhost:4000/" is unreachable — the device has no
  // route to the Mac's loopback — so we have to send the user through
  // Veronum's tunnel-mounted proxy instead.
  function isRemoteHost() {
    const h = window.location.hostname;
    return h && h !== "localhost" && h !== "127.0.0.1" && h !== "::1";
  }

  // Show + wire the "Preview renderer →" button for Electron projects.
  // - If a renderer URL is already known (existing Vite/CRA dev server,
  //   or a static server we started earlier), button opens it directly.
  // - Otherwise the button POSTs /api/preview/renderer-start, which
  //   spawns python3 -m http.server in the project's cwd, then opens
  //   the resulting URL.
  // Either way, on a remote (phone) host we route through the tunnel
  // proxy via reachableUrl(), so the phone can actually load it.
  function wireRendererButton({ rendererAvailable, rendererUrl, cwd }) {
    if (!els.previewOpenRenderer) return;
    if (!rendererAvailable) {
      els.previewOpenRenderer.hidden = true;
      els.previewOpenRenderer.onclick = null;
      return;
    }
    els.previewOpenRenderer.hidden = false;
    els.previewOpenRenderer.disabled = false;
    els.previewOpenRenderer.textContent = rendererUrl
      ? "Preview renderer →"
      : "Preview renderer (spawn server) →";
    els.previewOpenRenderer.onclick = async () => {
      try {
        els.previewOpenRenderer.disabled = true;
        els.previewOpenRenderer.textContent = "Starting renderer…";
        let url = rendererUrl;
        if (!url) {
          const r = await fetch("/api/preview/renderer-start", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cwd }),
          }).then((x) => x.json());
          if (!r.ok) throw new Error(r.error || "renderer-start failed");
          url = r.url;
        }
        const target = reachableUrl(url);
        try { window.open(target, "_blank", "noopener,noreferrer"); }
        catch { window.location.href = target; }
        els.previewOpenRenderer.textContent = "Preview renderer →";
        els.previewOpenRenderer.disabled = false;
      } catch (e) {
        els.previewOpenRenderer.textContent = "Preview renderer →";
        els.previewOpenRenderer.disabled = false;
        if (els.previewError) {
          els.previewError.hidden = false;
          els.previewError.textContent = "Renderer preview failed: " + e.message;
        }
      }
    };
  }

  // Turn "http://localhost:4000/" into a URL the current browser can
  // actually reach. On the Mac that's the localhost URL as-is; on the
  // phone we route through `${origin}/preview/<port>/` which the daemon
  // proxies to the Mac's localhost.
  function reachableUrl(localUrl) {
    const m = String(localUrl).match(/^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})\/?(.*)$/);
    if (!m) return localUrl;
    const port = m[1];
    const rest = m[2] || "";
    if (isRemoteHost()) {
      return `${window.location.origin}/preview/${port}/${rest}`;
    }
    return localUrl;
  }

  // Show the "Open in new tab" button pointing at `url`. The button
  // hands off to the OS browser — phone/Safari, Mac/Chrome, etc — so
  // the user gets full native interaction speed instead of a 1-fps
  // pixel stream.
  function showOpenInTab(url, script, cwdNote) {
    closePreviewWs?.(); // tear down any leftover stream
    const target = reachableUrl(url);
    const onTunnel = target !== url;
    const labelCwd = projectLabel(effectivePreviewCwd || currentCwd());
    if (els.previewEmptyTitle) {
      els.previewEmptyTitle.textContent = `${labelCwd} is running.`;
    }
    if (els.previewEmptyDetail) {
      const base = onTunnel ? `${url}  (proxied via Veronum tunnel)` : url;
      els.previewEmptyDetail.textContent = cwdNote ? `${cwdNote}  ${base}` : base;
    }
    if (els.previewOpenTab) {
      els.previewOpenTab.hidden = false;
      els.previewOpenTab.disabled = false;
      els.previewOpenTab.textContent = `Open ${script ? script + " " : ""}in new tab →`;
      els.previewOpenTab.onclick = () => {
        try { window.open(target, "_blank", "noopener,noreferrer"); }
        catch { window.location.href = target; }
      };
    }
    if (els.previewStartDev) els.previewStartDev.hidden = true;
    showPreviewEmpty();
  }

  // Electron equivalent of showOpenInTab: there's no URL to open, just
  // a native window on the Mac. We confirm "running" state and offer a
  // "Launch again" action that respawns the dev script — Electron's
  // single-instance handling takes care of focusing the existing window.
  //
  // Important: when the script uses concurrently/wait-on/vite (common
  // for Electron+renderer setups), the Electron window can take 20-30s
  // to actually appear on cold start. We surface this so the user
  // doesn't click Launch and conclude it failed after 3s.
  function showElectronRunning(script, logTail, justStarted, cwdNote) {
    closePreviewWs?.();
    const proj = projectLabel(effectivePreviewCwd || currentCwd());
    if (els.previewEmptyTitle) {
      els.previewEmptyTitle.textContent = justStarted
        ? `${proj} is starting…`
        : `${proj} is running on your Mac.`;
    }
    if (els.previewEmptyDetail) {
      const base = justStarted
        ? "Electron window can take 10-30s on cold start (Vite + bundler). Watch your Dock — the app icon will appear when it's ready. We'll keep streaming the log below."
        : "Native Electron window — no localhost URL.";
      els.previewEmptyDetail.textContent = cwdNote ? `${cwdNote}  ${base}` : base;
    }
    if (els.previewOpenTab) {
      els.previewOpenTab.hidden = false;
      els.previewOpenTab.disabled = false;
      els.previewOpenTab.textContent = "Launch again →";
      els.previewOpenTab.onclick = () => startDevServer();
    }
    if (els.previewStartDev) els.previewStartDev.hidden = true;
    // Live log display in the (re-styled, neutral-color) info box. The
    // user sees what the npm/electron child is printing in real time, so
    // they can tell whether they're waiting on Vite, on the bundler, or
    // on a hung step.
    if (els.previewError && logTail) {
      els.previewError.hidden = false;
      els.previewError.textContent = logTail;
      els.previewError.style.background = "rgba(120, 120, 120, .08)";
      els.previewError.style.borderColor = "rgba(180, 180, 180, .25)";
      els.previewError.style.color = "#cbd5e1";
      els.previewError.style.whiteSpace = "pre-wrap";
      els.previewError.style.maxHeight = "240px";
      els.previewError.style.overflow = "auto";
    }
    showPreviewEmpty();
    // If we just kicked off the launch, poll dev-status every 2s for the
    // next 60s so the log tail in the panel updates as Vite/Electron
    // print progress. Stops when the user navigates away.
    if (justStarted) {
      startElectronLogPoll(effectivePreviewCwd || currentCwd());
    }
  }

  // Poll dev-status to stream the live log tail into the panel until
  // either the user switches away or 60s elapses (after which the user
  // can hit "Launch again →" to refresh on demand).
  let electronPollTimer = null;
  function startElectronLogPoll(pollCwd) {
    if (electronPollTimer) { clearInterval(electronPollTimer); electronPollTimer = null; }
    const startedAt = Date.now();
    // Snapshot the session id so we can tell if the user switched sessions
    // (independent of cwd, since pollCwd may be a session-resolved project
    // root that differs from state.project.cwd).
    const pinnedSid = state.sessionId;
    electronPollTimer = setInterval(async () => {
      if (state.sessionId !== pinnedSid || activeTab !== "preview") {
        clearInterval(electronPollTimer);
        electronPollTimer = null;
        return;
      }
      try {
        const s = await fetch(`/api/preview/dev-status?cwd=${encodeURIComponent(pollCwd)}`).then((r) => r.json());
        if (s.logTail && els.previewError) {
          els.previewError.textContent = s.logTail;
        }
        // Flip to steady-state title when we see Vite/Electron ready signals.
        if (els.previewEmptyTitle && /vite.*ready|app[\s_]+ready|electron[\s\S]{0,20}ready|main window/i.test(s.logTail || "")) {
          els.previewEmptyTitle.textContent = `${projectLabel(pollCwd)} is running on your Mac.`;
          els.previewEmptyDetail.textContent = "Native Electron window — no localhost URL.";
        }
        // Refresh the renderer button — as the dev script starts up
        // it may have just announced a Vite URL we can now point the
        // phone at without spawning a separate static server.
        wireRendererButton({
          rendererAvailable: s.rendererAvailable,
          rendererUrl: s.rendererUrl,
          cwd: pollCwd,
        });
      } catch { /* server might be restarting */ }
      if (Date.now() - startedAt > 60000) {
        clearInterval(electronPollTimer);
        electronPollTimer = null;
      }
    }, 2000);
  }

  async function loadPorts() {
    const cwd = currentCwd();
    // Reset error / detail / buttons before re-checking.
    if (els.previewError) { els.previewError.hidden = true; els.previewError.textContent = ""; }
    if (els.previewStartDev) els.previewStartDev.hidden = true;
    if (els.previewOpenTab) {
      els.previewOpenTab.hidden = true;
      els.previewOpenTab.onclick = null;
    }
    if (els.previewOpenRenderer) {
      els.previewOpenRenderer.hidden = true;
      els.previewOpenRenderer.onclick = null;
    }
    if (els.previewEmptyDetail) els.previewEmptyDetail.textContent = "";

    if (!cwd) {
      // No session picked — empty state. Don't show arbitrary localhost
      // apps; the preview is tied to the session you're viewing.
      if (els.previewEmptyTitle) els.previewEmptyTitle.textContent = "Open a session to preview its project.";
      if (els.previewEmptyDetail) els.previewEmptyDetail.textContent = "";
      showPreviewEmpty();
      return;
    }

    // dev-status is the project-aware path: reads THIS session's
    // cwd/package.json (or index.html for static), tells us whether
    // the project's own server is running and how to start it.
    // We also pass the session source+id so the server can scan the
    // JSONL for a `cd <project>` if the literal cwd has nothing.
    if (els.previewEmptyTitle) els.previewEmptyTitle.textContent = "Checking project…";
    try {
      const params = new URLSearchParams({ cwd });
      if (state.editor) params.set("source", state.editor);
      if (state.sessionId) params.set("id", state.sessionId);
      const s = await fetch(`/api/preview/dev-status?${params.toString()}`).then((r) => r.json());
      // Server may have inferred a different project root from the session
      // history (e.g. user opened Claude in ~ then `cd electron-landing`).
      // From here on we operate against THAT path, not the literal cwd.
      effectivePreviewCwd = s.resolvedFromSession || cwd;
      const cwdNote = s.resolvedFromSession
        ? `Found project at ${s.resolvedFromSession} (session was opened in ${projectLabel(cwd)}).`
        : null;

      if (s.running && s.kind === "electron") {
        showElectronRunning(s.script, s.logTail, false, cwdNote);
        wireRendererButton({
          rendererAvailable: s.rendererAvailable,
          rendererUrl: s.rendererUrl,
          cwd: effectivePreviewCwd,
        });
        return;
      }
      if (s.running && s.url) {
        showOpenInTab(s.url, s.script, cwdNote);
        return;
      }
      if (s.devScriptAvailable) {
        // We can start it — show the Start button. After start succeeds
        // we switch to the appropriate running state.
        const isElectron = s.kind === "electron";
        const isStatic = s.kind === "static";
        const labelCwd = projectLabel(effectivePreviewCwd);
        if (els.previewEmptyTitle) {
          els.previewEmptyTitle.textContent = isElectron
            ? `${labelCwd} isn't running.`
            : `${labelCwd} dev server isn't running.`;
        }
        if (els.previewEmptyDetail) {
          const base = isElectron
            ? `Click to run \`npm run ${s.script}\` — opens the Electron app on your Mac.`
            : isStatic
              ? `Click to serve this folder via http.server.`
              : (s.cmd ? `Click to run \`npm run ${s.script}\` in this project.` : `Click below to start it.`);
          els.previewEmptyDetail.textContent = cwdNote ? `${cwdNote}  ${base}` : base;
        }
        if (els.previewStartDev) {
          els.previewStartDev.hidden = false;
          els.previewStartDev.disabled = false;
          els.previewStartDev.textContent = isElectron
            ? "Launch app on Mac"
            : isStatic
              ? "Serve folder"
              : `Start "${s.script || "dev"}" server`;
        }
        // For Electron, also surface the renderer-only preview option
        // (HTML inside the window — works on phones via tunnel proxy).
        if (isElectron) {
          wireRendererButton({
            rendererAvailable: s.rendererAvailable,
            rendererUrl: s.rendererUrl,
            cwd: effectivePreviewCwd,
          });
        }
        showPreviewEmpty();
        return;
      }
      // No dev script, no index.html — nothing to preview.
      if (els.previewEmptyTitle) {
        els.previewEmptyTitle.textContent = "Nothing to preview yet.";
      }
      if (els.previewEmptyDetail) {
        els.previewEmptyDetail.textContent = `${projectLabel(cwd)} has no package.json dev script and no index.html.`;
      }
      showPreviewEmpty();
    } catch (e) {
      if (els.previewEmptyTitle) els.previewEmptyTitle.textContent = "Couldn't check dev server.";
      if (els.previewEmptyDetail) els.previewEmptyDetail.textContent = e.message;
      showPreviewEmpty();
    }
  }

  async function loadGenericPorts() {
    els.portSelect.innerHTML = `<option value="">scanning…</option>`;
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
      els.portSelect.value = String(ports[0].port);
      openPreviewStream(String(ports[0].port));
    } catch {
      els.portSelect.innerHTML = `<option value="">discovery failed</option>`;
      showPreviewEmpty();
    }
  }

  function projectLabel(cwd) {
    const parts = String(cwd).split("/").filter(Boolean);
    return parts[parts.length - 1] || cwd;
  }

  async function startDevServer() {
    // Use the effective cwd resolved by loadPorts() (which may be
    // different from state.project.cwd if the user opened the session
    // in a non-project dir and `cd`'d into a real project).
    const cwd = effectivePreviewCwd || currentCwd();
    if (!cwd) return;
    if (els.previewError) { els.previewError.hidden = true; els.previewError.textContent = ""; }
    if (els.previewStartDev) {
      els.previewStartDev.disabled = true;
      els.previewStartDev.textContent = "Starting…";
    }
    if (els.previewEmptyDetail) els.previewEmptyDetail.textContent = "Spawning child process; waiting for the URL…";
    try {
      const r = await fetch("/api/preview/dev-start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd }),
      }).then((x) => x.json());
      if (!r.ok) throw new Error(r.error || "start failed");
      if (r.kind === "electron") {
        // Electron has no URL — the native window pops up on the Mac
        // when `npm run electron:dev` (or whatever) executes. Pass
        // justStarted so the UI shows cold-start timing + polls the
        // log for the next minute.
        showElectronRunning(r.script, r.logTail, true);
      } else if (r.url) {
        showOpenInTab(r.url, r.script);
        // Auto-open in a new tab on success — the click that started the
        // server counts as user-gesture, so popup blockers stay happy.
        // Route through the tunnel proxy on remote hosts.
        try { window.open(reachableUrl(r.url), "_blank", "noopener,noreferrer"); } catch {}
      } else {
        throw new Error("Dev server started but never announced a URL.");
      }
    } catch (e) {
      if (els.previewError) {
        els.previewError.hidden = false;
        els.previewError.textContent = e.message;
      }
      if (els.previewStartDev) {
        els.previewStartDev.disabled = false;
        els.previewStartDev.textContent = "Try again";
      }
      if (els.previewEmptyDetail) {
        els.previewEmptyDetail.textContent = "Couldn't start the dev server.";
      }
    }
  }
  els.previewStartDev?.addEventListener("click", startDevServer);

  function setViewport(vp) {
    if (stageEl) stageEl.dataset.vp = vp;
    els.vps.forEach((b) => b.classList.toggle("active", b.dataset.vp === vp));
  }
  els.portSelect?.addEventListener("change", () => {
    if (els.portSelect.value) openPreviewStream(els.portSelect.value);
    else showPreviewEmpty();
  });
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
    // In VS Code mode the panel IS the main view — closing it would
    // leave a blank screen. Pop the drawer open instead so the user
    // can pick another project.
    if (document.body.dataset.mode === "vscode") {
      const drawer = document.getElementById("drawer");
      if (drawer) drawer.dataset.open = "true";
      const backdrop = document.getElementById("drawer-backdrop");
      if (backdrop) backdrop.hidden = false;
      return;
    }
    els.panel.hidden = true;
    closePreviewWs(); // tear down the screencast stream when panel closes
  });
  els.reload.addEventListener("click", () => {
    if (activeTab === "files") loadFilesRoot();
    else if (els.portSelect.value) openPreviewStream(els.portSelect.value);
  });

  // Re-load the tree when the session changes while the panel is open.
  document.addEventListener("veronum:session-changed", () => {
    if (!els.panel.hidden && activeTab === "files") loadFilesRoot();
  });

  setViewport("full");
  els.panel.dataset.tab = "files";
})();

// ─── Billing modal + paywall ───────────────────────────────────────────
// Powers the always-on "Plan" button in the topbar AND the lockout
// banner that appears above the composer when a dispatch endpoint
// returns 402 payment_required. Exposes window.veronumBilling so the
// existing dispatch error handlers can trigger the paywall.
(() => {
  const FREE_LIMIT_CENTS = 25;
  const POLL_AFTER_PAYWALL_MS = 10_000;

  const els = {
    btn: document.getElementById("plan-btn"),
    modal: document.getElementById("billing-modal"),
    closeBtns: document.querySelectorAll("[data-billing-close]"),
    actionBtns: document.querySelectorAll("[data-billing-action]"),
    manageBtn: document.getElementById("billing-manage"),
    error: document.getElementById("billing-error"),
    paywall: document.getElementById("billing-paywall"),
    paywallMsg: document.getElementById("billing-paywall-message"),
    paywallCta: document.querySelector("#billing-paywall .billing-paywall-cta"),
    composer: document.getElementById("composer"),
    composerInput: document.getElementById("composer-input"),
    sendBtn: document.getElementById("send-btn"),
  };
  if (!els.btn || !els.modal) return;

  let cachedState = null;
  let pollTimer = null;
  let composerLocked = false;

  // Modal shows plan choices only — no usage / quota stats. We still
  // FETCH state in the background because we need to know whether
  // there's an active subscription (to swap Subscribe/PAYG buttons for
  // a Manage button) and to auto-unlock the composer after a payment.
  function render(state) {
    if (!state) return;
    const hasSub = state.has_active_subscription || state.tier === "chad" || state.tier === "payg";
    if (els.manageBtn) els.manageBtn.hidden = !hasSub;
    document.querySelectorAll('[data-billing-action="subscribe"], [data-billing-action="payg"]')
      .forEach((b) => { b.hidden = hasSub; });
  }

  async function refreshState() {
    try {
      const s = await fetch("/api/billing/state").then((r) => r.json());
      if (s.ok) cachedState = s;
      render(cachedState);
      // Auto-unlock composer if the user has paid since we last checked.
      if (composerLocked && cachedState && !cachedState.over_quota &&
          (cachedState.has_active_subscription || cachedState.tier === "payg" || cachedState.is_admin)) {
        clearPaywall();
      }
    } catch (e) {
      if (els.error) {
        els.error.hidden = false;
        els.error.textContent = "Couldn't reach billing: " + e.message;
      }
    }
  }

  function openModal() {
    els.modal.hidden = false;
    els.modal.setAttribute("aria-hidden", "false");
    refreshState();
  }
  function closeModal() {
    els.modal.hidden = true;
    els.modal.setAttribute("aria-hidden", "true");
  }

  els.btn.addEventListener("click", openModal);
  els.closeBtns.forEach((b) => b.addEventListener("click", closeModal));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !els.modal.hidden) closeModal();
  });

  // Each button POSTs to its respective daemon endpoint, which calls
  // the install-id-authed billing-bridge edge function to mint a fresh
  // Stripe URL, then opens that URL in a new tab. Asynchronous per
  // click — no stale URLs, no Stripe API quota burned until the user
  // actually clicks.
  const ACTION_TO_ENDPOINT = {
    subscribe: "/api/billing/checkout-flat",
    payg:      "/api/billing/checkout-payg",
    manage:    "/api/billing/portal",
  };
  els.actionBtns.forEach((btn) => {
    btn.addEventListener("click", async () => {
      const action = btn.dataset.billingAction;
      const endpoint = ACTION_TO_ENDPOINT[action];
      if (!endpoint) return;
      const originalLabel = btn.textContent;
      btn.disabled = true;
      btn.textContent = "Opening Stripe…";
      if (els.error) { els.error.hidden = true; els.error.textContent = ""; }
      try {
        const r = await fetch(endpoint, { method: "POST" }).then((x) => x.json());
        if (!r.ok || !r.url) throw new Error(r.error || "no_url");
        try { window.open(r.url, "_blank", "noopener,noreferrer"); }
        catch { window.location.href = r.url; }
        schedulePoll(); // catch the webhook-driven tier flip
      } catch (e) {
        if (els.error) {
          els.error.hidden = false;
          els.error.textContent = "Couldn't open Stripe: " + e.message;
        }
      } finally {
        btn.disabled = false;
        btn.textContent = originalLabel;
      }
    });
  });

  // ─── Paywall lockout ──────────────────────────────────────────────────
  // We deliberately do NOT echo the server's "$0.25 used" message; user
  // wants the banner to read as a simple call-to-action, not a meter.
  function triggerPaywall(_serverMessage) {
    composerLocked = true;
    if (els.paywall) {
      els.paywall.hidden = false;
      if (els.paywallMsg) els.paywallMsg.textContent = "Subscribe to keep using Veronum.";
    }
    if (els.composerInput) {
      els.composerInput.disabled = true;
      els.composerInput.placeholder = "Subscribe to keep using Veronum…";
    }
    if (els.sendBtn) els.sendBtn.disabled = true;
    schedulePoll();
  }

  function clearPaywall() {
    composerLocked = false;
    if (els.paywall) els.paywall.hidden = true;
    if (els.composerInput) {
      els.composerInput.disabled = false;
      els.composerInput.placeholder = "Ask Claude…";
    }
    if (els.sendBtn) els.sendBtn.disabled = false;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function schedulePoll() {
    if (pollTimer) return;
    pollTimer = setInterval(refreshState, POLL_AFTER_PAYWALL_MS);
  }

  if (els.paywallCta) {
    els.paywallCta.addEventListener("click", openModal);
  }

  // Public hook for the dispatch error handlers.
  window.veronumBilling = {
    triggerPaywall,
    clearPaywall,
    openModal,
    refresh: refreshState,
  };

  // Warm the cache at boot so the first modal open is instant.
  refreshState();
})();

// ─── Save / revert versions (git) ─────────────────────────────────
// Topbar save icon → modal with "Save this version" form + a list of
// past versions, each with a Revert button. All actions hit /api/git
// which runs real git commands in the project's cwd.
(() => {
  const els = {
    btn: document.getElementById("save-btn"),
    modal: document.getElementById("version-modal"),
    closeBtns: document.querySelectorAll("[data-version-close]"),
    nameInput: document.getElementById("version-name"),
    saveBtn: document.getElementById("version-save-btn"),
    msg: document.getElementById("version-msg"),
    list: document.getElementById("version-list"),
    remote: document.getElementById("version-remote"),
  };
  if (!els.btn || !els.modal) return;

  function cwd() {
    return (typeof state !== "undefined" && state?.project?.cwd) || null;
  }
  function fmtAgo(ts) {
    if (!ts) return "";
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 60) return Math.floor(s) + "s ago";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    return Math.floor(s / 86400) + "d ago";
  }
  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
  }
  function showMsg(text, kind) {
    if (!els.msg) return;
    els.msg.hidden = false;
    els.msg.textContent = text;
    els.msg.style.color = kind === "error" ? "#fda4af" : kind === "ok" ? "#86efac" : "";
  }
  function clearMsg() { if (els.msg) { els.msg.hidden = true; els.msg.textContent = ""; } }

  function open() {
    els.modal.hidden = false;
    els.modal.setAttribute("aria-hidden", "false");
    clearMsg();
    els.nameInput.value = "";
    refreshList();
    setTimeout(() => els.nameInput.focus(), 80);
  }
  function close() {
    els.modal.hidden = true;
    els.modal.setAttribute("aria-hidden", "true");
  }

  async function refreshList() {
    const c = cwd();
    if (!c) { els.list.innerHTML = `<p class="billing-note">Open a session or VS Code project first.</p>`; return; }
    els.list.innerHTML = `<p class="billing-note">loading…</p>`;
    try {
      const r = await fetch(`/api/git/log?cwd=${encodeURIComponent(c)}`).then((x) => x.json());
      if (!r.ok) throw new Error(r.error || "load failed");
      renderRemote(r.remote || {}, r.ghAvailable);
      if (!r.initialized || r.versions.length === 0) {
        els.list.innerHTML = `<p class="billing-note">No versions yet. Type a name above and tap Save to create your first one.</p>`;
        return;
      }
      els.list.innerHTML = "";
      r.versions.forEach((v, idx) => {
        const row = document.createElement("div");
        row.className = "version-row" + (idx === 0 ? " current" : "");
        row.innerHTML = `
          <div class="version-info">
            <div class="version-msg">${escapeHtml(v.message)}</div>
            <div class="version-meta">${escapeHtml(v.shortHash)} · ${fmtAgo(v.ts)}</div>
          </div>
          <button class="version-revert" type="button">Revert</button>
        `;
        const btn = row.querySelector(".version-revert");
        btn.addEventListener("click", async () => {
          const confirmText = `Revert to "${v.message}"?\n\nThis will overwrite your current files with the state from ${v.shortHash}. The current state stays in history, so you can revert again.`;
          if (!window.confirm(confirmText)) return;
          btn.disabled = true;
          btn.textContent = "Reverting…";
          try {
            const res = await fetch("/api/git/revert", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ cwd: c, hash: v.hash, name: `Revert to "${v.message}"` }),
            }).then((x) => x.json());
            if (!res.ok) throw new Error(res.error || "revert failed");
            const pushNote =
              res.push?.pushed ? ` ✓ pushed to ${res.push.branch || "remote"}` :
              res.push?.message === "no remote configured" ? "" :
              res.push ? ` (push failed: ${res.push.message})` : "";
            showMsg(`Reverted to "${v.message}".${pushNote}`, res.push && !res.push.pushed && res.push.message !== "no remote configured" ? "error" : "ok");
            // Tell the file tree + editor to re-read disk.
            document.dispatchEvent(new CustomEvent("veronum:session-changed", { detail: { project: state?.project } }));
            await refreshList();
            showPushStatus(res.push);
          } catch (e) {
            showMsg("Couldn't revert: " + e.message, "error");
            btn.disabled = false;
            btn.textContent = "Revert";
          }
        });
        els.list.appendChild(row);
      });
    } catch (e) {
      els.list.innerHTML = `<p class="billing-note">Error: ${escapeHtml(e.message)}</p>`;
    }
  }

  // Render the "remote" section. Three states:
  //   - Has remote → show its URL + a "✓ pushed" / "❌ push failed"
  //     status under the next save.
  //   - No remote + gh authed → show a "Create GitHub repo" form
  //     (name field + Public/Private buttons).
  //   - No remote + gh not authed → tell the user to run gh auth login.
  function renderRemote(info, ghAvailable) {
    if (!els.remote) return;
    if (info.hasRemote && info.remoteUrl) {
      els.remote.hidden = false;
      const niceUrl = info.remoteUrl.replace(/\.git$/, "").replace(/^git@github\.com:/, "https://github.com/");
      els.remote.innerHTML = `
        <span style="color:#86efac">●</span>
        <span class="version-remote-url" title="${escapeHtml(info.remoteUrl)}">${escapeHtml(niceUrl)}</span>
        <span class="version-remote-status" id="version-remote-status"></span>
      `;
      return;
    }
    els.remote.hidden = false;
    if (ghAvailable) {
      const def = ((cwd() || "").split("/").pop() || "my-project").replace(/[^A-Za-z0-9_-]/g, "-");
      els.remote.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:8px;width:100%">
          <div class="dim" style="font-size:12px">No GitHub remote yet. Create one in one tap:</div>
          <div class="version-create-row">
            <input id="version-create-name" type="text" placeholder="repo name" value="${escapeHtml(def)}" />
            <button class="version-create-btn" id="version-create-private">Private</button>
            <button class="version-create-btn" id="version-create-public" style="background:rgba(255,255,255,.06);color:var(--text,#f4f1ea)">Public</button>
          </div>
        </div>
      `;
      els.remote.querySelector("#version-create-private").addEventListener("click", () => createRepo("private"));
      els.remote.querySelector("#version-create-public").addEventListener("click", () => createRepo("public"));
    } else {
      els.remote.innerHTML = `
        <div class="dim" style="font-size:12px">
          No GitHub remote. To enable auto-push, either add one manually
          (<code>git remote add origin …</code>) or install + auth the
          <code>gh</code> CLI (<code>brew install gh && gh auth login</code>)
          and reopen this modal.
        </div>
      `;
    }
  }

  async function createRepo(visibility) {
    const c = cwd();
    if (!c) return;
    const nameEl = els.remote.querySelector("#version-create-name");
    const name = (nameEl?.value || "").trim();
    if (!name) { showMsg("Pick a repo name first.", "error"); return; }
    const btns = els.remote.querySelectorAll("button");
    btns.forEach((b) => { b.disabled = true; });
    showMsg(`Creating ${visibility} repo "${name}" + pushing…`, "ok");
    try {
      const r = await fetch("/api/git/create-github-repo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: c, name, visibility }),
      }).then((x) => x.json());
      if (!r.ok) throw new Error(r.error || "create failed");
      showMsg(`✓ Created + pushed to ${r.remoteUrl}`, "ok");
      refreshList();
    } catch (e) {
      showMsg("Couldn't create repo: " + e.message, "error");
      btns.forEach((b) => { b.disabled = false; });
    }
  }

  // Show the push result after a save/revert in the remote status pill.
  function showPushStatus(push) {
    const el = document.getElementById("version-remote-status");
    if (!el) return;
    if (!push) { el.textContent = ""; el.dataset.state = ""; return; }
    if (push.pushed) {
      el.textContent = "✓ pushed";
      el.dataset.state = "ok";
    } else if (push.message === "no changes") {
      el.textContent = "";
      el.dataset.state = "";
    } else if (push.message === "no remote configured") {
      el.textContent = "";
      el.dataset.state = "";
    } else {
      el.textContent = "❌ push failed";
      el.dataset.state = "err";
      el.title = push.message || "";
    }
  }

  async function save() {
    const c = cwd();
    if (!c) { showMsg("Open a session or VS Code project first.", "error"); return; }
    const name = els.nameInput.value.trim();
    if (!name) { showMsg("Give this version a name first.", "error"); return; }
    els.saveBtn.disabled = true;
    els.saveBtn.textContent = "Saving…";
    clearMsg();
    try {
      const r = await fetch("/api/git/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: c, message: name }),
      }).then((x) => x.json());
      if (!r.ok) throw new Error(r.error || "save failed");
      if (r.noChanges) {
        showMsg("Nothing to save — the current files match the last version.", "ok");
      } else {
        const pushNote =
          r.push?.pushed ? ` ✓ pushed to ${r.push.branch || "remote"}` :
          r.push?.message === "no remote configured" ? "" :
          r.push ? ` (push failed: ${r.push.message})` : "";
        showMsg(`Saved as "${name}" (${(r.hash || "").slice(0, 7)}).${pushNote}`, r.push && !r.push.pushed && r.push.message !== "no remote configured" ? "error" : "ok");
        els.nameInput.value = "";
      }
      await refreshList();
      showPushStatus(r.push);
    } catch (e) {
      showMsg("Couldn't save: " + e.message, "error");
    } finally {
      els.saveBtn.disabled = false;
      els.saveBtn.textContent = "Save";
    }
  }

  els.btn.addEventListener("click", open);
  els.closeBtns.forEach((b) => b.addEventListener("click", close));
  els.saveBtn.addEventListener("click", save);
  els.nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !els.modal.hidden) close();
  });
})();

// ─── Activity tab — recent edits feed ─────────────────────────────
// Pulls AI Edit/Write/MultiEdit calls from the current session's JSONL
// plus the in-app editor's saves, renders each as an expandable
// red/green diff, and lets the user name each change (persisted to
// .veronum/edits.json per project).
(() => {
  const els = {
    tabBtn: document.querySelector('.preview-tab[data-tab="activity"]'),
    body: document.querySelector('.preview-body[data-tab="activity"]'),
    list: document.getElementById("activity-list"),
    summary: document.getElementById("activity-summary"),
    refresh: document.getElementById("activity-refresh"),
    undoBtn: document.getElementById("activity-undo"),
    redoBtn: document.getElementById("activity-redo"),
  };
  if (!els.tabBtn || !els.body) return;

  let lastLoadKey = null;
  let undoState = { nextUndo: null, nextRedo: null };

  function fmtAgo(ts) {
    if (!ts) return "";
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 60) return Math.floor(s) + "s ago";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    return Math.floor(s / 86400) + "d ago";
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
  }

  // Simple LCS-based line diff. Returns an array of {type: 'add'|'del'|'ctx', text}.
  // Inputs capped at 2000 lines each to keep the DP table cheap.
  function lineDiff(before, after) {
    const a = String(before || "").split("\n").slice(0, 2000);
    const b = String(after || "").split("\n").slice(0, 2000);
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const out = [];
    let i = 0, j = 0;
    while (i < m && j < n) {
      if (a[i] === b[j]) { out.push({ type: "ctx", text: a[i] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: "del", text: a[i] }); i++; }
      else { out.push({ type: "add", text: b[j] }); j++; }
    }
    while (i < m) { out.push({ type: "del", text: a[i++] }); }
    while (j < n) { out.push({ type: "add", text: b[j++] }); }
    return out;
  }

  function renderDiff(before, after) {
    if (before == null) {
      // Write tool — no "before" available. Just show the new file
      // contents with all lines as additions.
      const lines = String(after || "").split("\n").slice(0, 500);
      return lines.map((l) => `<div class="diff-line add">${escapeHtml(l)}</div>`).join("");
    }
    const lines = lineDiff(before, after);
    // Collapse long runs of unchanged context to ±3 lines around each
    // change so the diff stays scannable for large blocks.
    const collapsed = [];
    const CONTEXT = 3;
    let runStart = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].type === "ctx") {
        if (runStart === -1) runStart = i;
      } else if (runStart !== -1) {
        // Trim trailing context of the previous run, leading context of this one.
        const runLen = i - runStart;
        if (runLen > CONTEXT * 2 + 1) {
          collapsed.push(...lines.slice(runStart, runStart + CONTEXT).map((l) => l));
          collapsed.push({ type: "ctx", text: `… ${runLen - CONTEXT * 2} unchanged lines …` });
          collapsed.push(...lines.slice(i - CONTEXT, i).map((l) => l));
        } else {
          collapsed.push(...lines.slice(runStart, i));
        }
        runStart = -1;
        collapsed.push(lines[i]);
      } else {
        collapsed.push(lines[i]);
      }
    }
    if (runStart !== -1) {
      // Trailing context.
      const runLen = lines.length - runStart;
      if (runLen > CONTEXT) {
        collapsed.push(...lines.slice(runStart, runStart + CONTEXT));
        if (runLen > CONTEXT) collapsed.push({ type: "ctx", text: `… ${runLen - CONTEXT} unchanged lines …` });
      } else {
        collapsed.push(...lines.slice(runStart));
      }
    }
    return collapsed.map((l) => `<div class="diff-line ${l.type}">${escapeHtml(l.text)}</div>`).join("");
  }

  function renderEntry(e) {
    const div = document.createElement("div");
    div.className = "activity-entry";
    div.dataset.id = e.id;
    const defaultName = e.relPath + (e.isWrite ? " (wrote)" : "");
    const displayName = e.name || defaultName;
    div.innerHTML = `
      <div class="activity-entry-head">
        <span class="activity-source" data-source="${escapeHtml(e.source)}">${escapeHtml(e.source)}</span>
        <span class="activity-counts">
          <span class="activity-added">+${e.added}</span><span class="activity-removed">-${e.removed}</span>
        </span>
        <span class="activity-path">${escapeHtml(displayName)}</span>
        <span class="activity-time">${fmtAgo(e.ts)}</span>
      </div>
      <div class="activity-entry-body">
        <div class="activity-name-row">
          <input type="text" placeholder="Name this change…" value="${escapeHtml(e.name || "")}" />
          <button class="activity-name-save" type="button">Save name</button>
        </div>
        <div class="activity-diff">${renderDiff(e.before, e.after)}</div>
      </div>
    `;
    const head = div.querySelector(".activity-entry-head");
    head.addEventListener("click", () => div.classList.toggle("open"));
    const input = div.querySelector("input");
    const saveBtn = div.querySelector(".activity-name-save");
    const persist = async () => {
      const cwd = (typeof state !== "undefined" && state?.project?.cwd) || null;
      if (!cwd) return;
      try {
        await fetch("/api/activity/name", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd, id: e.id, name: input.value }),
        });
        e.name = input.value;
        const pathSpan = div.querySelector(".activity-path");
        if (pathSpan) pathSpan.textContent = e.name || defaultName;
        saveBtn.textContent = "✓ saved";
        setTimeout(() => { saveBtn.textContent = "Save name"; }, 1500);
      } catch (err) {
        saveBtn.textContent = "Error";
      }
    };
    saveBtn.addEventListener("click", persist);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") persist(); });
    return div;
  }

  async function load() {
    const cwd = (typeof state !== "undefined" && state?.project?.cwd) || null;
    if (!cwd) {
      els.list.innerHTML = `<div class="activity-empty">Open a session or VS Code project first.</div>`;
      els.summary.textContent = "";
      return;
    }
    const source = (typeof state !== "undefined" && state?.editor) || "";
    const sid = (typeof state !== "undefined" && state?.sessionId) || "";
    const key = `${source}|${cwd}|${sid}`;
    lastLoadKey = key;
    els.summary.textContent = "loading…";
    try {
      const params = new URLSearchParams({ cwd });
      if (source && source !== "vscode") params.set("source", source);
      if (sid && !String(sid).startsWith("vscode:")) params.set("id", sid);
      const r = await fetch("/api/activity?" + params.toString()).then((x) => x.json());
      if (key !== lastLoadKey) return; // user navigated away while we loaded
      if (!r.ok) throw new Error(r.error || "load failed");
      els.list.innerHTML = "";
      if (!r.edits || r.edits.length === 0) {
        els.list.innerHTML = `<div class="activity-empty">No edits yet. AI edits + your saves will appear here.</div>`;
        els.summary.textContent = "0 edits";
        updateUndoButtons(null, null);
        return;
      }
      for (const e of r.edits) els.list.appendChild(renderEntry(e));
      els.summary.textContent = `${r.edits.length} edit${r.edits.length === 1 ? "" : "s"}`;
      // Compute undo/redo state from the same edits we just rendered.
      updateUndoButtons(...computeUndoState(r.edits));
    } catch (e) {
      els.list.innerHTML = `<div class="activity-empty">Error: ${escapeHtml(e.message)}</div>`;
      els.summary.textContent = "error";
    }
  }

  // Mirror of the server-side computeUndoState (lib/activity.js).
  // Returns [nextUndo, nextRedo] so the buttons can enable/disable
  // and show what they're about to undo.
  function computeUndoState(edits) {
    const undone = new Set();
    const redone = new Set();
    let nextUndo = null, nextRedo = null;
    for (const e of edits) {
      if (e.source === "redo" && e.undoneId) {
        redone.add(e.undoneId);
        undone.delete(e.undoneId);
      } else if (e.source === "undo" && e.undoneId) {
        if (!redone.has(e.undoneId)) {
          undone.add(e.undoneId);
          if (!nextRedo) nextRedo = e;
        } else {
          redone.delete(e.undoneId);
        }
      } else if (e.source === "claude" || e.source === "cursor" || e.source === "user") {
        if (!nextUndo && !undone.has(e.id)) nextUndo = e;
      }
    }
    return [nextUndo, nextRedo];
  }

  function updateUndoButtons(nextUndo, nextRedo) {
    undoState = { nextUndo, nextRedo };
    if (els.undoBtn) {
      els.undoBtn.disabled = !nextUndo;
      els.undoBtn.title = nextUndo
        ? `Undo: ${nextUndo.name || nextUndo.relPath} (${nextUndo.source})`
        : "Nothing to undo";
    }
    if (els.redoBtn) {
      els.redoBtn.disabled = !nextRedo;
      els.redoBtn.title = nextRedo ? `Redo last undo` : "Nothing to redo";
    }
  }

  async function doUndo() {
    const cwd = (typeof state !== "undefined" && state?.project?.cwd) || null;
    if (!cwd || !undoState.nextUndo) return;
    els.undoBtn.disabled = true;
    try {
      const source = (state?.editor && state.editor !== "vscode") ? state.editor : "";
      const sid = (state?.sessionId && !String(state.sessionId).startsWith("vscode:")) ? state.sessionId : "";
      const r = await fetch("/api/activity/undo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, source, id: sid }),
      }).then((x) => x.json());
      if (!r.ok) throw new Error(r.error || "undo failed");
      // Reload activity + tell the file tree/editor to re-read disk.
      document.dispatchEvent(new CustomEvent("veronum:session-changed", { detail: { project: state?.project } }));
      await load();
    } catch (e) {
      alert("Couldn't undo: " + e.message);
      els.undoBtn.disabled = false;
    }
  }

  async function doRedo() {
    const cwd = (typeof state !== "undefined" && state?.project?.cwd) || null;
    if (!cwd || !undoState.nextRedo) return;
    els.redoBtn.disabled = true;
    try {
      const source = (state?.editor && state.editor !== "vscode") ? state.editor : "";
      const sid = (state?.sessionId && !String(state.sessionId).startsWith("vscode:")) ? state.sessionId : "";
      const r = await fetch("/api/activity/redo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, source, id: sid }),
      }).then((x) => x.json());
      if (!r.ok) throw new Error(r.error || "redo failed");
      document.dispatchEvent(new CustomEvent("veronum:session-changed", { detail: { project: state?.project } }));
      await load();
    } catch (e) {
      alert("Couldn't redo: " + e.message);
      els.redoBtn.disabled = false;
    }
  }

  els.tabBtn.addEventListener("click", () => setTimeout(load, 50));
  els.refresh.addEventListener("click", load);
  els.undoBtn?.addEventListener("click", doUndo);
  els.redoBtn?.addEventListener("click", doRedo);
  document.addEventListener("veronum:session-changed", () => {
    if (els.body && !els.body.hidden) load();
  });

  // Global cmd+Z / cmd+shift+Z. Only fires when no text input is
  // focused (so typing in the editor / chat doesn't trigger global
  // undo). The active tab must be Activity OR the file editor for
  // the shortcut to make sense — but for now we let it fire from
  // anywhere in the workspace panel since that's where users live.
  document.addEventListener("keydown", (e) => {
    const meta = e.metaKey || e.ctrlKey;
    if (!meta) return;
    const tag = (document.activeElement?.tagName || "").toLowerCase();
    // Don't hijack cmd+Z while inside an input/textarea — native
    // editor undo takes priority for that field.
    if (tag === "textarea" || tag === "input") return;
    const key = e.key.toLowerCase();
    if (key === "z" && !e.shiftKey) { e.preventDefault(); doUndo(); }
    else if ((key === "z" && e.shiftKey) || key === "y") { e.preventDefault(); doRedo(); }
  });
})();

// ─── In-browser terminal ────────────────────────────────────────────
// Real zsh via node-pty on the server, xterm.js on the client. Each
// "+" click spawns a fresh shell rooted at the current session's cwd.
// Tabs in the strip switch between live terminals; "×" closes one.
// xterm.js + fit addon are loaded lazily from CDN the first time the
// Terminal tab is opened, so the bundle stays small for users who
// only use Files / Preview.
(() => {
  const els = {
    tabBtn: document.querySelector('.preview-tab[data-tab="terminal"]'),
    stage: document.getElementById("term-stage"),
    strip: document.getElementById("term-tab-strip"),
    addBtn: document.getElementById("term-add-btn"),
    empty: document.getElementById("term-empty"),
    panel: document.getElementById("preview-panel"),
  };
  if (!els.tabBtn || !els.stage) return;

  // xterm + addon-fit are served locally from /vendor/xterm/* — see
  // server.js (no CDN dependency, avoids load failures on networks
  // that block jsdelivr / unpkg).
  let loadingXterm = null;
  function ensureXterm() {
    if (window.Terminal && (window.FitAddon?.FitAddon || window.FitAddon)) return Promise.resolve();
    if (loadingXterm) return loadingXterm;
    loadingXterm = new Promise((resolve, reject) => {
      const css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = "/vendor/xterm/css/xterm.css";
      document.head.appendChild(css);

      const s1 = document.createElement("script");
      s1.src = "/vendor/xterm/lib/xterm.js";
      s1.onload = () => {
        const s2 = document.createElement("script");
        s2.src = "/vendor/xterm-fit/lib/addon-fit.js";
        s2.onload = () => resolve();
        s2.onerror = () => reject(new Error("addon-fit failed to load"));
        document.body.appendChild(s2);
      };
      s1.onerror = () => reject(new Error("xterm.js failed to load"));
      document.body.appendChild(s1);
    });
    return loadingXterm;
  }

  function currentCwd() {
    return (typeof state !== "undefined" && state?.project?.cwd) || null;
  }
  function projectLabel(cwd) {
    const parts = String(cwd).split("/").filter(Boolean);
    return parts[parts.length - 1] || cwd;
  }

  const terms = new Map(); // id → { container, xterm, fit, ws, tabEl, cwd }
  let activeTermId = null;
  let _nextId = 1;

  async function spawnTerm() {
    try { await ensureXterm(); }
    catch (e) {
      els.empty.hidden = false;
      els.empty.textContent = "Couldn't load xterm.js: " + e.message;
      return;
    }
    const cwd = currentCwd();
    if (!cwd) {
      els.empty.hidden = false;
      els.empty.textContent = "Open a session first — terminals are rooted at the session's project folder.";
      return;
    }

    const id = _nextId++;
    const container = document.createElement("div");
    container.className = "term-instance";
    els.stage.appendChild(container);
    els.empty.hidden = true;

    // Tab pill in the strip.
    const tabEl = document.createElement("div");
    tabEl.className = "term-tab";
    const label = document.createElement("span");
    label.textContent = `${projectLabel(cwd)} · #${id}`;
    const closeBtn = document.createElement("button");
    closeBtn.className = "term-tab-close";
    closeBtn.type = "button";
    closeBtn.textContent = "×";
    closeBtn.setAttribute("aria-label", "Close terminal");
    tabEl.appendChild(label);
    tabEl.appendChild(closeBtn);
    els.strip.appendChild(tabEl);

    // xterm instance.
    const FitAddonCtor = window.FitAddon?.FitAddon || window.FitAddon;
    const term = new window.Terminal({
      fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
      fontSize: 13,
      cursorBlink: true,
      convertEol: false,
      scrollback: 5000,
      theme: {
        background: "#141414",
        foreground: "#f4f1ea",
        cursor: "#a78bfa",
        selectionBackground: "rgba(167,139,250,0.30)",
      },
    });
    const fit = new FitAddonCtor();
    term.loadAddon(fit);
    term.open(container);
    try { fit.fit(); } catch {}

    // WebSocket to the daemon's terminal mount.
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/api/terminal/stream` +
      `?cwd=${encodeURIComponent(cwd)}&cols=${term.cols}&rows=${term.rows}`;
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => {
      term.write(`\x1b[2;37m✦ zsh @ ${cwd}\x1b[0m\r\n`);
    };
    ws.onmessage = (e) => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === "data") term.write(msg.data);
      else if (msg.type === "exit") term.write(`\r\n\x1b[31m[shell exited]\x1b[0m\r\n`);
      else if (msg.type === "error") term.write(`\r\n\x1b[31merror: ${msg.message}\x1b[0m\r\n`);
    };
    ws.onerror = () => term.write(`\r\n\x1b[31m[ws error]\x1b[0m\r\n`);

    term.onData((data) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: "input", data }));
      }
    });
    term.onResize(({ cols, rows }) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols, rows }));
      }
    });

    terms.set(id, { id, container, xterm: term, fit, ws, tabEl, cwd });

    tabEl.addEventListener("click", (e) => {
      if (e.target === closeBtn) return;
      activate(id);
    });
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      destroy(id);
    });

    activate(id);
  }

  function activate(id) {
    activeTermId = id;
    for (const [tid, t] of terms) {
      t.container.hidden = tid !== id;
      t.tabEl.classList.toggle("active", tid === id);
      if (tid === id) {
        try { t.fit.fit(); } catch {}
        try { t.xterm.focus(); } catch {}
      }
    }
  }

  function destroy(id) {
    const t = terms.get(id);
    if (!t) return;
    try { t.ws.close(); } catch {}
    try { t.xterm.dispose(); } catch {}
    t.container.remove();
    t.tabEl.remove();
    terms.delete(id);
    if (activeTermId === id) {
      activeTermId = null;
      const next = terms.keys().next().value;
      if (next != null) activate(next);
      else { els.empty.hidden = false; els.empty.textContent = "Tap + above to start a new terminal."; }
    }
  }

  els.addBtn.addEventListener("click", spawnTerm);

  // Auto-spawn the first terminal the moment the user opens the tab —
  // skips an extra click for the most common case (1 terminal).
  els.tabBtn.addEventListener("click", () => {
    setTimeout(() => {
      if (terms.size === 0 && currentCwd()) spawnTerm();
      else {
        for (const t of terms.values()) {
          try { t.fit.fit(); } catch {}
        }
      }
    }, 60);
  });

  // Refit the active terminal on window resize or panel resize.
  window.addEventListener("resize", () => {
    if (activeTermId == null) return;
    const t = terms.get(activeTermId);
    if (t) try { t.fit.fit(); } catch {}
  });
})();
