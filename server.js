// Veronum Chat Localhost — minimal Express port of the chat mechanism
// from the Veronum overlay Electron app. Single browser UI for picking
// any Claude Code OR Cursor Agent session, viewing the full chat, and
// dispatching new prompts that stream back live.
//
// Same disk reads as the overlay (lib/jsonlCache.js + lib/claudeReader.js
// + lib/cursor.js are ported verbatim or with minimal adaptation).
// Same dispatch mechanism (subprocess spawn of `claude --resume` /
// `cursor-agent`). Differs only in how it's surfaced — HTTP + SSE
// instead of Electron IPC.

const path = require("node:path");
// Load .env from project root before anything else reads process.env.
// File holds ELEVENLABS_API_KEY (server-side secret, never exposed
// to the browser) and VERONUM_ELEVENLABS_AGENT_ID. Gitignored.
require("dotenv").config({ path: path.join(__dirname, ".env") });

const express = require("express");
const fs = require("node:fs");
const os = require("node:os");
const { spawn, execSync } = require("node:child_process");

const jsonlCache = require("./lib/jsonlCache");
const claudeReader = require("./lib/claudeReader");
const cursorReader = require("./lib/cursor");
const vscodeReader = require("./lib/vscode");

const PORT = parseInt(process.env.PORT || "3001", 10);

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use((req, _res, next) => {
  // Lightweight request log — visible in the terminal so we can see
  // exactly what the browser is doing.
  if (!req.url.startsWith("/style.css") && !req.url.startsWith("/app.js")) {
    console.log(`[${new Date().toISOString().slice(11, 19)}] ${req.method} ${req.url}`);
  }
  next();
});
// File tree + reader endpoints (/api/files/tree + /api/files/read).
// Sandboxed under the session's cwd (which the browser already knows
// from state.project.cwd). See lib/projectFiles.js.
const { mountProjectFiles } = require("./lib/projectFiles");
mountProjectFiles(app);

// Recent-edits feed: scans the active session's JSONL for AI Edit/
// Write/MultiEdit tool calls + merges in-app editor saves. Powers
// the Activity tab in the workspace panel.
const { mountActivity } = require("./lib/activity");
mountActivity(app);

// Save / revert versions via git. Save = git commit, revert = restore
// a previous commit's tree and record it as its own commit so history
// is never lost. See lib/git.js.
const { mountGit } = require("./lib/git");
mountGit(app);

// Pixel-streaming live preview. Spawns headless Chrome via CDP and
// pipes JPEG frames over a WebSocket to whatever client (phone, desktop)
// is connected. Replaces the path-rewriting HTTP proxy approach, which
// broke against every modern dev server's absolute-URL emissions.
// See lib/livePreview.js. WS upgrade is attached below after listen().
const { mountLivePreview } = require("./lib/livePreview");

// Project dev-server lifecycle (POST /api/preview/dev-start, etc).
// Reads the session's cwd/package.json, runs `npm run dev`, parses the
// announced URL from stdout, hands it back to the UI so the live
// preview can immediately point at the user's actual app — rather
// than whatever random localhost port happened to be listening.
const { mountDevServer } = require("./lib/projectDevServer");
mountDevServer(app);

// Session URL scan — reads the active Claude/Cursor session's JSONL
// and pulls the most recent live localhost URL out of whatever it
// printed (assistant text, Bash tool_result, etc.). Lets the preview
// panel jump straight to the URL Cursor/Claude already announced
// instead of probing ports.
const { mountSessionUrl } = require("./lib/sessionUrlScan");
mountSessionUrl(app);

// Re-mount the /preview/:port/* HTTP proxy so phones (which can't reach
// the Mac's localhost) can view dev servers through Veronum's
// cloudflared tunnel. mountPreviewProxy injects <base href> into HTML
// responses so relative URLs resolve correctly. WS upgrades for HMR
// are attached to the httpServer below after app.listen().
const { mountPreviewProxy } = require("./lib/previewProxy");
// mountPreviewProxy registers BOTH /preview/:port/* (proxy) and
// /api/preview/ports (port discovery), and attaches a WS upgrade
// handler later when we pass it httpServer.

app.use(express.static(path.join(__dirname, "public")));

// Serve xterm + xterm-addon-fit from node_modules so the terminal UI
// works without a CDN dependency (CDN load was failing for some users).
app.use("/vendor/xterm", express.static(path.join(__dirname, "node_modules/@xterm/xterm")));
app.use("/vendor/xterm-fit", express.static(path.join(__dirname, "node_modules/@xterm/addon-fit")));

// ─── PROJECT + SESSION LISTING ─────────────────────────────────────

app.get("/api/projects", async (_req, res) => {
  try {
    const [claudeRaw, cursorRaw] = await Promise.all([
      claudeReader.listClaudeProjects(),
      Promise.resolve(cursorReader.listProjects ? cursorReader.listProjects() : []),
    ]);
    const vscodeRaw = vscodeReader.listProjects();
    // Normalize all three into { cwd, label, sessionCount } so the
    // client doesn't care which editor a project belongs to.
    const claude = claudeRaw.map((p) => ({
      cwd: p.cwd, label: p.label || p.cwd.split("/").pop() || p.cwd,
      sessionCount: p.sessionCount || 0,
    }));
    const cursor = cursorRaw.map((p) => ({
      cwd: p.fullPath || p.id || "",
      label: p.name || (p.fullPath || "").split("/").pop() || "(cursor)",
      sessionCount: 0, // cursor.js doesn't give session count via listProjects
    }));
    const vscode = vscodeRaw.map((p) => ({
      cwd: p.fullPath || p.id || "",
      label: p.name || (p.fullPath || "").split("/").pop() || "(vscode)",
      sessionCount: 0, // VS Code has no Veronum session concept — just open the folder
    }));
    res.json({ ok: true, claude, cursor, vscode });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/claude/sessions", async (req, res) => {
  const cwd = String(req.query.cwd || "");
  if (!cwd) return res.status(400).json({ ok: false, error: "cwd required" });
  try {
    const sessions = await claudeReader.listSessions(cwd);
    res.json({ ok: true, sessions });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// What models does the user's cursor-agent CLI have access to? Veronum
// overlay calls `cursor-agent --list-models` and shows the result in a
// picker. We do the same — cached so we don't re-spawn cursor-agent on
// every page load.
app.get("/api/cursor/models", async (_req, res) => {
  try {
    const models = await getCursorModels();
    res.json({ ok: true, models });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, models: [] });
  }
});

// Static list of Claude model short names + effort levels. Mirrors what
// Veronum overlay's UI exposes.
app.get("/api/claude/models", (_req, res) => {
  res.json({
    ok: true,
    models: [
      { short: "opus",   label: "Opus — best quality",   id: CLAUDE_MODEL_MAP.opus },
      { short: "sonnet", label: "Sonnet — balanced",     id: CLAUDE_MODEL_MAP.sonnet },
      { short: "haiku",  label: "Haiku — fastest",       id: CLAUDE_MODEL_MAP.haiku },
    ],
    efforts: [
      { value: "max",    label: "Max — deepest thinking" },
      { value: "high",   label: "High" },
      { value: "medium", label: "Medium" },
      { value: "low",    label: "Low — quickest" },
    ],
  });
});

app.get("/api/cursor/sessions", async (req, res) => {
  const cwd = String(req.query.cwd || "");
  if (!cwd) return res.status(400).json({ ok: false, error: "cwd required" });
  try {
    const sessions = cursorReader.listSessions ? cursorReader.listSessions(cwd) : [];
    // Normalize each entry: { sessionId, size, mtimeMs }
    const normalized = (sessions || []).map((s) => ({
      sessionId: s.id || s.sessionId || s.chatId,
      size: s.size || 0,
      mtimeMs: s.lastMtime || s.mtimeMs || 0,
    }));
    res.json({ ok: true, sessions: normalized });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── CHAT HISTORY ─────────────────────────────────────────────────

app.get("/api/claude/session", async (req, res) => {
  const cwd = String(req.query.cwd || "");
  const sid = String(req.query.sid || "");
  if (!cwd || !/^[a-f0-9-]{32,40}$/i.test(sid)) {
    return res.status(400).json({ ok: false, error: "cwd + valid sid required" });
  }
  try {
    const located = await claudeReader.findSessionJsonl(sid, cwd);
    if (!located) {
      return res.json({ ok: true, title: "(empty)", messages: [], freshSession: true });
    }
    const parsed = await jsonlCache.getOrParse(located.path, claudeReader.parseClaudeJsonl);
    res.json({ ok: true, title: parsed.title, messages: parsed.messages, mtimeMs: located.mtimeMs });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/cursor/session", async (req, res) => {
  const cwd = String(req.query.cwd || "");
  const sid = String(req.query.sid || "");
  if (!cwd || !sid) {
    return res.status(400).json({ ok: false, error: "cwd + sid required" });
  }
  try {
    const result = await cursorReader.getSession(cwd, sid);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── DISPATCH (subprocess spawn + SSE streaming) ───────────────────
//
// Same approach as veronum-overlay/main.js:1934 (`claudeCode:sendInSession`):
// spawn `claude --print --resume <sid>` with --output-format stream-json,
// parse each JSON event, push assistant-text chunks to the browser via
// Server-Sent Events. Browser shows the response growing live.
//
// Race-guard: refuse if claude is already running on this session (would
// corrupt the JSONL). This mirrors veronum-overlay's
// `isClaudeAlreadyRunningOnSession` check.

function isClaudeAlreadyRunningOnSession(sid) {
  try {
    const out = execSync(
      `ps -Ao pid,command | grep -F "claude" | grep -F "--resume" | grep -F "${sid}" | grep -v grep`,
      { encoding: "utf8", timeout: 1000 }
    );
    const first = out.split("\n").map((l) => l.trim()).filter(Boolean)[0];
    return first ? { running: true, match: first } : { running: false };
  } catch { return { running: false }; }
}

function whichClaudeBin() {
  try {
    return execSync("command -v claude", { encoding: "utf8" }).trim() || "claude";
  } catch { return "claude"; }
}
function whichCursorAgentBin() {
  try {
    return execSync("command -v cursor-agent", { encoding: "utf8" }).trim() || "cursor-agent";
  } catch { return "cursor-agent"; }
}

// Claude model short-name → what we pass to `claude --model`.
// The claude CLI accepts both short aliases ("opus"/"sonnet"/"haiku")
// and full versioned IDs ("claude-opus-4-7"). We use the short aliases
// because they're subscription-tier-agnostic. Earlier this map used
// "claude-opus-4-7[1m]" (1-million-context beta) — that returned
// HTTP 400 "long context beta not yet available for this subscription"
// on standard tiers. Short aliases work everywhere.
const CLAUDE_MODEL_MAP = {
  opus: "opus",
  sonnet: "sonnet",
  haiku: "haiku",
};
const CLAUDE_EFFORT_OPTIONS = new Set(["low", "medium", "high", "max"]);

function resolveClaudeModel(short) {
  if (!short) return CLAUDE_MODEL_MAP.opus;
  if (CLAUDE_MODEL_MAP[short]) return CLAUDE_MODEL_MAP[short];
  // Already a full model id (e.g. user passed "claude-opus-4-7[1m]")
  return short;
}

// Probe cursor-agent for the user's available models. Cached for 30s so
// the page doesn't re-spawn cursor-agent on every load. Returns array of
// { name, available }.
let _cursorModelsCache = null;
let _cursorModelsCachedAt = 0;
async function getCursorModels() {
  if (_cursorModelsCache && Date.now() - _cursorModelsCachedAt < 30_000) {
    return _cursorModelsCache;
  }
  return await new Promise((resolve) => {
    const bin = whichCursorAgentBin();
    const child = spawn(bin, ["--list-models"], { env: process.env });
    let out = "", err = "";
    const killer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 12_000);
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { err += d.toString(); });
    child.on("close", () => {
      clearTimeout(killer);
      // Parse output — `cursor-agent --list-models` prints one model per
      // line in the format "<model-id> - <human label>" (e.g.
      // "auto - Auto (current)"). We split on " - " so the dropdown
      // value is just the model id (what --model expects) while the
      // label is shown to the user.
      const models = out
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => {
          if (!s) return false;
          if (s.startsWith("#")) return false;
          const lower = s.toLowerCase();
          // Drop section headers and the trailing usage tip that
          // cursor-agent prints after the model list (otherwise it ends
          // up in the dropdown as a fake model).
          if (lower.includes("available models")) return false;
          if (lower.startsWith("tip:")) return false;
          if (lower.startsWith("note:")) return false;
          if (lower.startsWith("usage:")) return false;
          return true;
        })
        .map((line) => {
          const idx = line.indexOf(" - ");
          if (idx > 0) {
            return { id: line.slice(0, idx).trim(), label: line.slice(idx + 3).trim() };
          }
          return { id: line, label: line };
        });
      _cursorModelsCache = models;
      _cursorModelsCachedAt = Date.now();
      resolve(models);
    });
    child.on("error", () => { clearTimeout(killer); resolve([]); });
  });
}

// Helper: open an SSE connection, return { sendEvent, close } so the
// dispatch handler can stream messages over it.
function openSseStream(res) {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
  function sendEvent(eventName, data) {
    res.write(`event: ${eventName}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }
  function close() { try { res.end(); } catch {} }
  return { sendEvent, close };
}

// Build the system-prompt addendum we append to every Claude --resume
// dispatch. Tells the model where the canonical full transcript lives
// on disk and how to query it with Bash — so that questions about the
// start of the conversation, message counts, or anything older than
// what fits in context become a tool call against the JSONL instead of
// a confabulation from whatever happens to be in the context window.
//
// We do NOT inject the answers themselves; we hand Claude the same
// affordances a developer agent has (path + jq/grep snippets) and let
// it decide when to look.
const CHAT_HISTORY_BIN = path.join(__dirname, "bin", "chat-history");

function buildHistoryAwareSystemPrompt(jsonlPath) {
  // Use the chat-history helper rather than jq one-liners because jq
  // isn't installed on every system. The helper is python3-only and
  // emits user-message text without loading the whole 16MB file into
  // either Bash output or the model's context.
  return [
    "This is a resumed Claude Code session. Your context window holds only a recent slice of the full conversation; the canonical complete transcript on disk is:",
    "",
    `  ${jsonlPath}`,
    "",
    "When the user asks about the start of the conversation, the first/earliest message, message counts, timestamps, or anything older than what you can see in your context, you MUST query that file via the Bash tool — do NOT trust your in-context memory for those questions. Quote the file's contents verbatim when answering.",
    "",
    `A helper script is installed at ${CHAT_HISTORY_BIN} that returns the exact text without loading the file. Use it instead of head/sed/cat/grep (the file is tens of MB and may contain base64-encoded images).`,
    "",
    "Commands:",
    `  • First user message:        ${CHAT_HISTORY_BIN} first "${jsonlPath}"`,
    `  • Count user text messages:  ${CHAT_HISTORY_BIN} count "${jsonlPath}"`,
    `  • Nth user message (1-idx):  ${CHAT_HISTORY_BIN} nth N "${jsonlPath}"`,
    `  • First message timestamp:   ${CHAT_HISTORY_BIN} first-ts "${jsonlPath}"`,
    `  • List first 10 (idx,ts,prv): ${CHAT_HISTORY_BIN} list "${jsonlPath}"`,
    `  • Search user messages:       ${CHAT_HISTORY_BIN} grep PATTERN "${jsonlPath}"`,
    "",
    "That helper reads the JSONL directly; its output is the source of truth.",
  ].join("\n");
}

app.post("/api/claude/send", async (req, res) => {
  const { cwd, sessionId, prompt, model, effort } = req.body || {};
  if (!cwd || !sessionId || typeof prompt !== "string" || !prompt.trim()) {
    res.status(400).json({ ok: false, error: "cwd, sessionId, prompt required" });
    return;
  }
  // Billing gate — atomic check + record. Fails closed on Supabase
  // error (rather than silently allowing) so we never lose track of
  // free-quota consumption while the network is flaky.
  if (billingGate) {
    try {
      const g = await billingGate.gateClaudeDispatch();
      if (!g.allowed) {
        res.status(402).json(billingGate.paywallResponse(g));
        return;
      }
    } catch (e) {
      console.warn("[gate] claude dispatch gate failed:", e.message);
      res.status(503).json({ ok: false, error: "billing_unavailable", detail: e.message });
      return;
    }
  }
  const conflict = isClaudeAlreadyRunningOnSession(sessionId);
  if (conflict.running) {
    res.status(409).json({
      ok: false,
      error: "session-busy",
      detail: `Claude Desktop has this session open (pid ${conflict.match.split(/\s+/)[0]}). Close that tab in Claude Desktop, then try again — or pick a different session.`,
    });
    return;
  }

  const useModelShort = CLAUDE_MODEL_MAP[model] ? model : "opus";
  const useModelId = resolveClaudeModel(useModelShort);
  const useEffort = CLAUDE_EFFORT_OPTIONS.has(effort) ? effort : "max";

  const { sendEvent, close } = openSseStream(res);
  sendEvent("status", {
    phase: "spawning",
    detail: `spawning claude (${useModelShort}, ${useEffort}) --resume ${sessionId.slice(0,8)}…`,
  });

  const claudeBin = whichClaudeBin();

  // Resolve the JSONL on disk so we can point the resumed Claude at it.
  // When a session is long enough that the context window can't hold the
  // whole transcript (15+ MB on Katya), Claude --resume only sees a
  // recent slice and confidently answers meta-history questions with
  // whatever oldest message happens to fit in context. Telling Claude
  // where its full record lives — and how to query it with Bash — turns
  // those questions into a tool call instead of a confabulation.
  const located = await claudeReader.findSessionJsonl(sessionId, cwd);
  const historyPrompt = located ? buildHistoryAwareSystemPrompt(located.path) : null;

  const args = [
    "--resume", sessionId,
    "--output-format", "stream-json",
    "--verbose",
    "--model", useModelId,
    "--fallback-model", "sonnet",
    "--effort", useEffort,
    // Bypass interactive permission prompts so Claude can actually
    // write files / run bash / use tools. Without this, every dispatch
    // that needs to touch a file stalls on "I need your permission…"
    // Veronum overlay uses the same flag (main.js:1934 spawn args).
    "--permission-mode", "bypassPermissions",
    "--allow-dangerously-skip-permissions",
    // Tool parity with the interactive `claude` the user normally runs:
    //   - --tools default        →  full built-in set (Read, Write, Edit,
    //                               Bash, Grep, Glob, NotebookEdit,
    //                               TodoWrite, WebFetch, WebSearch, ...)
    //   - --setting-sources       →  user (~/.claude), project (.claude/),
    //                               and local (.claude.local/) — so hooks,
    //                               custom agents, MCP servers, CLAUDE.md,
    //                               and slash commands all load
    "--tools", "default",
    "--setting-sources", "user,project,local",
    // Grant Claude access to the session's cwd PLUS the localhost repo
    // (so it can read the chat-history helper / its own server code if
    // asked) PLUS the .claude projects dir (so it can read sibling
    // sessions if you ask about them).
    "--add-dir", cwd,
    "--add-dir", __dirname,
    "--add-dir", path.join(os.homedir(), ".claude", "projects"),
  ];
  if (historyPrompt) args.push("--append-system-prompt", historyPrompt);
  args.push("-p", prompt);
  console.log(`[dispatch] spawning ${claudeBin} --resume ${sessionId.slice(0,8)} in ${cwd}`);
  const child = spawn(claudeBin, args, { cwd, env: process.env });
  const spawnedAt = Date.now();

  // Heartbeat: if no text has arrived after 5s, send a "still loading"
  // status. Keep firing every 10s so the UI knows we're alive.
  let lastUpdateAt = Date.now();
  const heartbeat = setInterval(() => {
    if (accumulated.length > 0) return; // got real text — stop heartbeating
    const elapsed = Math.round((Date.now() - spawnedAt) / 1000);
    sendEvent("status", {
      phase: "loading",
      detail: `Claude is loading the session (${elapsed}s) — big sessions can take 60-180s to compact`,
      elapsedSeconds: elapsed,
    });
  }, 5000);

  let accumulated = "";
  let toolUseCount = 0;
  let buffer = "";

  function handleLine(line) {
    if (!line.trim()) return;
    let obj;
    try { obj = JSON.parse(line); } catch { return; }
    if (obj.type === "assistant" && obj.message?.content) {
      for (const part of obj.message.content) {
        if (part?.type === "text" && typeof part.text === "string") {
          accumulated += (accumulated ? "\n" : "") + part.text;
          sendEvent("delta", { text: part.text, accumulated });
        } else if (part?.type === "tool_use") {
          toolUseCount++;
          sendEvent("tool_use", { name: part.name, count: toolUseCount });
        }
      }
    } else if (obj.type === "result") {
      sendEvent("result", {
        is_error: !!obj.is_error,
        subtype: obj.subtype,
        result: obj.result,
        total_cost_usd: obj.total_cost_usd,
        num_turns: obj.num_turns,
      });
    }
  }

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) handleLine(line);
  });
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString().slice(0, 1000);
    if (text.trim()) sendEvent("stderr", { text });
  });
  child.on("error", (err) => {
    clearInterval(heartbeat);
    sendEvent("error", { message: "spawn failed: " + err.message });
    close();
  });
  child.on("close", (code) => {
    clearInterval(heartbeat);
    if (buffer.trim()) handleLine(buffer);
    // Invalidate cache so the next /api/claude/session refresh re-reads
    const located = findCachePathSync(sessionId, cwd);
    if (located) jsonlCache.invalidate(located);
    const totalSec = Math.round((Date.now() - spawnedAt) / 1000);
    console.log(`[dispatch] done sid=${sessionId.slice(0,8)} code=${code} ${accumulated.length}ch in ${totalSec}s`);
    sendEvent("done", {
      code,
      accumulated,
      toolUseCount,
      durationMs: Date.now() - spawnedAt,
    });
    close();
  });

  // Kill the child if the CLIENT disconnects (browser tab closed, fetch
  // reader cancelled, etc.). We listen on `res.on('close')` — NOT
  // `req.on('close')` — because the request stream's 'close' event
  // fires as soon as the body is fully received (always immediately for
  // our small POST). Using req here killed every dispatch at 0s.
  res.on("close", () => {
    if (res.writableEnded) return; // we ended it normally
    console.log(`[dispatch] client disconnected — killing child`);
    try { child.kill("SIGKILL"); } catch {}
  });
});

// Tiny sync helper (claudeReader.findSessionJsonl is async; we want a
// quick path lookup at close-time for cache invalidation without
// blocking the close handler in an await).
function findCachePathSync(sid, cwd) {
  const dirName = claudeReader.encodeProjectPath(cwd);
  const fp = path.join(claudeReader.CLAUDE_PROJECTS_DIR, dirName, sid + ".jsonl");
  return fs.existsSync(fp) ? fp : null;
}

app.post("/api/cursor/send", async (req, res) => {
  const { cwd, sessionId, prompt, model } = req.body || {};
  if (!cwd || typeof prompt !== "string" || !prompt.trim()) {
    res.status(400).json({ ok: false, error: "cwd + prompt required" });
    return;
  }
  if (billingGate) {
    try {
      const g = await billingGate.gateCursorDispatch();
      if (!g.allowed) {
        res.status(402).json(billingGate.paywallResponse(g));
        return;
      }
    } catch (e) {
      console.warn("[gate] cursor dispatch gate failed:", e.message);
      res.status(503).json({ ok: false, error: "billing_unavailable", detail: e.message });
      return;
    }
  }
  const { sendEvent, close } = openSseStream(res);
  sendEvent("status", { phase: "spawning" });

  const cursorBin = whichCursorAgentBin();
  const args = ["--print", "--output-format", "text"];
  if (sessionId) args.push("--resume", sessionId);
  // Pass model only if the user explicitly picked one. cursor-agent
  // defaults to "auto" which is usually correct.
  if (model && model !== "auto") args.push("--model", model);
  args.push(prompt);
  console.log(`[cursor-dispatch] spawning ${cursorBin} ${args.slice(0,-1).join(" ")} <prompt ${prompt.length}ch>`);

  // stdio[0] = "ignore" so cursor-agent gets EOF on stdin immediately.
  // Without this the CLI sits forever waiting for piped input, even with
  // --print + a prompt arg, and emits nothing — which is exactly the
  // "dispatch didn't reach Cursor" symptom we were seeing.
  // Also pass --trust so it doesn't block on the workspace-trust prompt.
  if (!args.includes("--trust")) args.unshift("--trust");
  const child = spawn(cursorBin, args, {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let accumulated = "";
  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    accumulated += text;
    sendEvent("delta", { text, accumulated });
  });
  child.stderr.on("data", (chunk) => {
    sendEvent("stderr", { text: chunk.toString().slice(0, 1000) });
  });
  child.on("error", (err) => {
    sendEvent("error", { message: "spawn failed: " + err.message });
    close();
  });
  child.on("close", (code) => {
    sendEvent("done", { code, accumulated });
    close();
  });
  // res.on('close'), NOT req.on('close'). The request stream's 'close'
  // event fires as soon as the POST body is fully received (instant
  // for our small JSON body), which was SIGKILL'ing cursor-agent
  // before it could produce any output — same bug we fixed in the
  // Claude dispatch path above.
  res.on("close", () => {
    if (res.writableEnded) return;
    try { child.kill("SIGKILL"); } catch {}
  });
});

// ─── ElevenLabs voice token ───────────────────────────────────────
// Mints a short-lived ConvAI conversation token (JWT containing a
// LiveKit room name) from ElevenLabs. The browser uses this token to
// open a WebRTC session to the agent we configured server-side —
// exactly the same pattern as the old voice console and as Happy.
//
// Notes:
//   - ELEVENLABS_API_KEY stays on the server. The browser never sees it.
//   - VERONUM_ELEVENLABS_AGENT_ID defaults to the agent we built in
//     the ElevenLabs dashboard (already has the sendMessageToSession
//     clientTool wired in its config).
//   - Token has its own short expiry; if the user starts/stops voice
//     repeatedly we mint a fresh one each time.

const ELEVENLABS_DEFAULT_AGENT = "agent_8301ksdyvcn7eqa9mrs37s0w63x2";

app.get("/api/voice/token", async (_req, res) => {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const agentId = process.env.VERONUM_ELEVENLABS_AGENT_ID || ELEVENLABS_DEFAULT_AGENT;
  if (!apiKey) {
    return res.status(500).json({
      ok: false,
      error: "ELEVENLABS_API_KEY not set",
      detail: "Put it in /Users/dylanwain/veronum-chat-localhost/.env",
    });
  }
  try {
    const r = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=${encodeURIComponent(agentId)}`,
      { headers: { "xi-api-key": apiKey } },
    );
    if (!r.ok) {
      const body = await r.text();
      return res.status(502).json({
        ok: false,
        error: "elevenlabs token mint failed",
        status: r.status,
        body: body.slice(0, 500),
      });
    }
    const data = await r.json();
    res.json({ ok: true, token: data.token, agentId });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── OpenAI Realtime: Companion voice agent ───────────────────────
// The Companion is an always-on voice channel running on OpenAI's
// Realtime API. It lives alongside the user's Claude/Cursor session:
//   - It receives live SSE-derived context updates as Claude works
//     (so it knows what's happening without us routing through it).
//   - It exposes tools the user can call by voice: submit_to_claude,
//     summarize_claude_response, query_session_history, web_search.
//   - PTT (push-to-talk to Claude) runs through a SEPARATE pipeline
//     (gpt-4o-transcribe → existing /api/claude/send). The Companion
//     is muted during PTT to avoid cross-talk.
//
// We mint an EPHEMERAL client_secret server-side so the browser can
// open the WebRTC directly to OpenAI without our long-lived API key
// ever leaving the server.

// GA Realtime API (the beta endpoint was retired). Model name + URLs
// match what the old voice console used (gpt-realtime / marin).
const REALTIME_MODEL = "gpt-realtime";
const REALTIME_VOICE = "marin";

function companionInstructions() {
  // Static-ish system prompt for the Companion. Kept short because
  // Realtime sessions are sensitive to long instructions (latency).
  return [
    "You are a hands-free voice dispatcher for the user's Claude Code (or Cursor) coding session. The user's hands are busy. Your job is to FORWARD what they say to their coding agent.",
    "",
    "DEFAULT BEHAVIOR — for ANYTHING the user says, treat it as a prompt to forward:",
    "  1. SPEAK FIRST: say out loud what you're about to send, in the form: 'Sending to Claude: <the prompt>.' (or 'Sending to Cursor: ...' if the session is Cursor). Use the user's own words — do NOT translate, do NOT paraphrase beyond minor grammar cleanup, do NOT add anything.",
    "  2. THEN call submit_to_claude with that same prompt text.",
    "",
    "The user MUST hear what you're sending before the tool call, every time. This is non-negotiable. If you call submit_to_claude without speaking the 'Sending to Claude: ...' announcement first, you have failed.",
    "",
    "ONLY skip submit_to_claude when the user EXPLICITLY invokes one of these by name:",
    "  - 'summarize Claude's reply' / 'read me the last reply' → call summarize_claude_response",
    "  - 'what was my first message' / 'my last message' / 'how many messages' / 'find <X> in my history' → call query_session_history with the matching action",
    "  - 'search the web for <X>' / 'google <X>' → call web_search",
    "Everything else — questions, requests, ideas, complaints, observations, 'can you' / 'please' / 'I want' — goes to submit_to_claude. Never treat a project question as a history query.",
    "",
    "OTHER RULES:",
    "- Do NOT greet yourself or say your name. Stay silent on connect.",
    "- After dispatching, stay quiet until the user speaks again or you receive a 'CLAUDE_FINISHED: <text>' system message — then give a 1-2 sentence summary.",
    "- Never echo the user's words back as a question. If you didn't catch what they said, say 'sorry, again?' — don't paraphrase to confirm.",
  ].join("\n");
}

// Function tool definitions handed to OpenAI Realtime via session.update.
// The browser implements these as event handlers on the data channel:
//   - the model emits response.function_call_arguments.done
//   - the browser dispatches the call to the matching /api/voice/* endpoint
//   - the result is pushed back via conversation.item.create + response.create.
const COMPANION_TOOLS = [
  {
    type: "function",
    name: "submit_to_claude",
    description:
      "Forward a prompt to the user's currently-active Claude or Cursor session as if they typed it. Use this when the user says 'tell Claude to X' or 'ask Cursor to Y'. The prompt should be the full request, paraphrased into clean text.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "The full prompt to forward to the coding session.",
        },
      },
      required: ["prompt"],
    },
  },
  {
    type: "function",
    name: "summarize_claude_response",
    description:
      "Return the text of Claude's most recent reply in the current session so you can summarize it aloud. Call this when the user asks 'what did Claude say' or 'summarize that'.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "query_session_history",
    description:
      "Query the canonical chat history on disk for facts about the session: the first message, message count, timestamps, or grep-style search. Use this for any 'what was my first message', 'how many messages', or 'when did I ask about X' question.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["first", "last", "count", "nth", "list", "grep"],
          description:
            "Which query to run. Use 'first' for the opening message, 'last' for the most recent user message, 'nth' with n for a specific index, 'count' for the total, 'list' to enumerate, 'grep' to search by regex.",
        },
        n: {
          type: "integer",
          description: "Index for 'nth' (1-based) or limit for 'list' (default 10).",
        },
        pattern: {
          type: "string",
          description: "Regex pattern for 'grep'.",
        },
      },
      required: ["action"],
    },
  },
  {
    type: "function",
    name: "web_search",
    description:
      "Search the web and return a synthesized answer. Use when the user asks you to look something up, research a topic, or find current information not in the codebase.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query." },
      },
      required: ["query"],
    },
  },
];

// Mint an ephemeral client_secret for OpenAI Realtime. Browser opens
// the WebRTC directly to OpenAI using this secret.
app.get("/api/voice/realtime-token", async (_req, res) => {
  // Gate voice at session start. Voice is metered per-minute server-side
  // but we charge a 1-min minimum at session open so the user can't
  // sneak in a sub-second session right at the quota edge.
  if (billingGate) {
    try {
      const g = await billingGate.gateVoiceSession();
      if (!g.allowed) {
        return res.status(402).json(billingGate.paywallResponse(g));
      }
    } catch (e) {
      console.warn("[gate] voice session gate failed:", e.message);
      return res.status(503).json({ ok: false, error: "billing_unavailable", detail: e.message });
    }
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      ok: false,
      error: "OPENAI_API_KEY not set",
      detail: "Put it in /Users/dylanwain/veronum-chat-localhost/.env",
    });
  }
  try {
    // GA endpoint /v1/realtime/client_secrets accepts a `session`
    // wrapper with type: "realtime". Audio config is nested under
    // audio.input / audio.output. Tools + instructions live on the
    // session object too. Response is { value, expires_at } directly.
    const r = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        session: {
          type: "realtime",
          model: REALTIME_MODEL,
          instructions: companionInstructions(),
          tools: COMPANION_TOOLS,
          tool_choice: "auto",
          audio: {
            input: {
              turn_detection: {
                type: "server_vad",
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 600,
              },
              // Pin Whisper to English — auto-detect was mis-routing short
            // utterances as Chinese/other and the model would then forward
            // the *translated* prompt to Claude. The user is an English
            // speaker; if non-English support is ever needed, expose a
            // setting rather than relying on detection.
            transcription: { model: "whisper-1", language: "en" },
            },
            output: {
              voice: REALTIME_VOICE,
            },
          },
        },
      }),
    });
    if (!r.ok) {
      const body = await r.text();
      return res.status(502).json({
        ok: false,
        error: "realtime session mint failed",
        status: r.status,
        body: body.slice(0, 800),
      });
    }
    const data = await r.json();
    // GA shape: { value, expires_at } at top level.
    res.json({
      ok: true,
      clientSecret: data.value,
      expiresAt: data.expires_at,
      model: REALTIME_MODEL,
      voice: REALTIME_VOICE,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// PTT transcription: receive audio bytes, return text. Used by the
// hold-to-talk button. We use gpt-4o-transcribe (cheaper + faster
// than whisper for short PTT chunks) with the audio as multipart.
//
// Body comes in via express.raw (set up below). We rebuild it into
// FormData here so we can hit OpenAI's multipart endpoint without
// pulling in `multer` or `formidable`.
app.post(
  "/api/voice/transcribe",
  express.raw({ type: "*/*", limit: "25mb" }),
  async (req, res) => {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ ok: false, error: "OPENAI_API_KEY not set" });
    }
    if (!Buffer.isBuffer(req.body) || req.body.length < 100) {
      return res.status(400).json({ ok: false, error: "no audio body" });
    }
    try {
      const ct = req.headers["content-type"] || "audio/webm";
      const ext = ct.includes("ogg") ? "ogg" : ct.includes("mp4") ? "mp4" : "webm";
      const blob = new Blob([req.body], { type: ct });
      const form = new FormData();
      form.append("file", blob, `ptt.${ext}`);
      form.append("model", "gpt-4o-transcribe");
      form.append("response_format", "json");
      const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      });
      if (!r.ok) {
        const body = await r.text();
        // Log the OpenAI rejection server-side so the localhost
        // terminal shows the actual reason (browser only sees the
        // 502 we return). Include MIME type + size for debugging
        // since most transcribe failures are about codec/format.
        console.warn(
          `[transcribe] OpenAI ${r.status}`,
          { mime: ct, bytes: req.body.length, body: body.slice(0, 500) },
        );
        return res.status(502).json({
          ok: false,
          error: `transcribe failed (${r.status})`,
          mime: ct,
          bytes: req.body.length,
          openaiBody: body.slice(0, 500),
        });
      }
      const data = await r.json();
      res.json({ ok: true, text: data.text || "" });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  },
);

// web_search tool implementation: proxy through OpenAI's Responses
// API with web_search_preview enabled. Cheaper than running our own
// crawler and uses the OpenAI key we already have.
app.post("/api/voice/web-search", async (req, res) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ ok: false, error: "OPENAI_API_KEY not set" });
  }
  const { query } = req.body || {};
  if (!query || typeof query !== "string") {
    return res.status(400).json({ ok: false, error: "query required" });
  }
  try {
    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        tools: [{ type: "web_search_preview" }],
        input: `Search the web and answer concisely (2-3 sentences max, cite sources by URL): ${query}`,
      }),
    });
    if (!r.ok) {
      const body = await r.text();
      return res.status(502).json({
        ok: false,
        error: "web search failed",
        status: r.status,
        body: body.slice(0, 500),
      });
    }
    const data = await r.json();
    // Responses API: output is an array of items; we want the
    // assistant text from the last message item.
    let text = "";
    for (const item of data.output || []) {
      if (item.type === "message" && Array.isArray(item.content)) {
        for (const c of item.content) {
          if (c.type === "output_text" && c.text) text += c.text;
        }
      }
    }
    res.json({ ok: true, answer: text || "(no answer)" });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// query_session_history tool implementation: thin shell around the
// chat-history helper script so the Companion can ask about meta-
// history without needing to know the JSONL path.
app.post("/api/voice/session-history", async (req, res) => {
  const { cwd, sessionId, action, n, pattern } = req.body || {};
  if (!cwd || !sessionId) {
    return res.status(400).json({ ok: false, error: "cwd + sessionId required" });
  }
  try {
    const located = await claudeReader.findSessionJsonl(sessionId, cwd);
    if (!located) {
      return res.status(404).json({ ok: false, error: "session jsonl not found" });
    }
    const ALLOWED = new Set(["first", "last", "nth", "count", "list", "grep"]);
    if (!ALLOWED.has(action)) {
      return res.status(400).json({
        ok: false,
        error: `unknown action ${JSON.stringify(action)}; allowed: ${[...ALLOWED].join(", ")}`,
      });
    }
    const args = [action];
    if (action === "nth") args.push(String(n || 1));
    if (action === "grep") args.push(pattern || ".");
    if (action === "list" && n) args.push(String(n));
    args.push(located.path);
    const helper = path.join(__dirname, "bin", "chat-history");
    const child = spawn(helper, args);
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { err += d.toString(); });
    child.on("close", (code) => {
      if (code !== 0 && !out) {
        return res.json({ ok: false, error: err.trim() || `helper exited ${code}` });
      }
      res.json({ ok: true, result: out.trim() });
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Cloud bridge (Supabase Realtime) ────────────────────────────
// Connects this daemon to its Supabase broadcast channel so a signed-in
// user at chat.thetoolswebsite.com can dispatch from any device.
// LOCAL_ONLY=1 skips the cloud connection (use for dev when you don't
// want the daemon to phone home).

const bridgeSupabase =
  process.env.LOCAL_ONLY === "1" ? null : require("./lib/bridgeSupabase");
// Billing gate — atomically checks the user's free quota / subscription
// state and records usage. Skipped in LOCAL_ONLY (no paired user to
// charge); silently allows when daemon is unpaired (reason='unpaired').
const billingGate =
  process.env.LOCAL_ONLY === "1" ? null : require("./lib/billingGate");
// In-app billing UI endpoints: GET /api/billing/state + /api/billing/links.
// Powers the "Plan" topbar button + the over-quota paywall. Mounted in
// every mode (including LOCAL_ONLY) so the UI doesn't have to branch;
// LOCAL_ONLY just gets a synthesized "no-billing" snapshot.
const { mountBilling } = require("./lib/billing");
mountBilling(app);
// cloudflared lifecycle — spawned alongside bridgeSupabase so the paired
// browser session can reach this Mac from any device. URL changes flow
// to bridgeSupabase.setTunnelUrl which publishes to Supabase via the
// heartbeat RPC. Skipped in LOCAL_ONLY mode (no point in a tunnel when
// nobody on the cloud side is paired).
const bridgeCloudflared =
  process.env.LOCAL_ONLY === "1" || process.env.VERONUM_DISABLE_CLOUDFLARED === "1"
    ? null
    : require("./lib/bridgeCloudflared");

// Mutable record so HTTP endpoints (consumed by the menu bar via
// electron/main.js) can introspect bridge state without going through
// the lib module's internal closure.
const bridgeState = {
  state: "uninit",
  detail: null,
  userId: null,
  pairCode: null,
  pairUrl: null,
  installId: null,
};

// Generic HTTP proxy over the channel — accepts {method, path, body,
// stream} and forwards to our own localhost server, then sends the
// response back. Lets the cloud chat web app talk to the daemon using
// almost the same code it used in localhost mode (just wrap fetch in
// bridgeFetch on the client). Supports both:
//   - one-shot JSON responses (the common case: /api/projects,
//     /api/claude/sessions, /api/voice/realtime-token, etc.)
//   - SSE streaming responses (the dispatch endpoints) — emits
//     bridge.fetch.chunk for each event, bridge.fetch.done at the end.
async function handleChannelFetch(message) {
  const p = message?.payload || {};
  const requestId = p.request_id || Math.random().toString(36).slice(2);
  const method = (p.method || "GET").toUpperCase();
  const path = p.path || "/api/health";
  const body = p.body; // string | object | undefined
  const wantsStream = !!p.stream;

  const url = `http://127.0.0.1:${PORT}${path}`;
  const init = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body !== undefined && method !== "GET" && method !== "HEAD") {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }

  let resp;
  try {
    resp = await fetch(url, init);
  } catch (e) {
    await bridgeSupabase.sendOutbound("bridge.fetch.error", {
      request_id: requestId,
      message: e.message,
    });
    return;
  }

  if (!wantsStream) {
    // One-shot JSON response. Read full body, ship it as a single event.
    const text = await resp.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    await bridgeSupabase.sendOutbound("bridge.fetch.response", {
      request_id: requestId,
      status: resp.status,
      ok: resp.ok,
      body: parsed,
    });
    return;
  }

  // SSE streaming response — translate each event to a channel broadcast.
  const reader = resp.body.getReader();
  const dec = new TextDecoder("utf-8");
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() || "";
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
      await bridgeSupabase.sendOutbound("bridge.fetch.chunk", {
        request_id: requestId,
        event,
        ...payload,
      });
    }
  }
  await bridgeSupabase.sendOutbound("bridge.fetch.done", {
    request_id: requestId,
    status: resp.status,
    ok: resp.ok,
  });
}

// Channel handler: when a paired chat client sends a `dispatch.request`
// broadcast, we proxy it through our own localhost HTTP endpoint and
// forward each SSE event back to the channel as a broadcast. This reuses
// the existing dispatch code (claude --resume / cursor-agent) verbatim
// — no refactor of the SSE handlers.
async function handleChannelDispatch(message) {
  if (message?.type !== "dispatch.request") return;
  const p = message.payload || {};
  const requestId = p.request_id || Math.random().toString(36).slice(2);
  const editor = p.editor === "cursor" ? "cursor" : "claude";
  const endpoint = editor === "cursor" ? "/api/cursor/send" : "/api/claude/send";

  // Echo a "received" status so the browser knows the request landed.
  await bridgeSupabase.sendOutbound("dispatch.status", {
    request_id: requestId,
    phase: "received",
    detail: "daemon accepted",
  });

  let sseResp;
  try {
    sseResp = await fetch(`http://127.0.0.1:${PORT}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cwd: p.cwd,
        sessionId: p.sessionId,
        prompt: p.prompt,
        model: p.model,
        effort: p.effort,
      }),
    });
    if (!sseResp.ok) {
      const detail = await sseResp.text().catch(() => "");
      await bridgeSupabase.sendOutbound("dispatch.error", {
        request_id: requestId,
        message: `local ${endpoint} returned ${sseResp.status}`,
        detail: detail.slice(0, 400),
      });
      return;
    }
  } catch (e) {
    await bridgeSupabase.sendOutbound("dispatch.error", {
      request_id: requestId,
      message: "could not reach local dispatch: " + e.message,
    });
    return;
  }

  // Stream-parse SSE, forward each event to the channel with the
  // request_id baked in (so the browser can correlate concurrent
  // dispatches).
  const reader = sseResp.body.getReader();
  const dec = new TextDecoder("utf-8");
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() || "";
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
      // Re-namespace the event to dispatch.<original>
      const channelEvent = `dispatch.${event}`;
      try {
        await bridgeSupabase.sendOutbound(channelEvent, {
          request_id: requestId,
          ...payload,
        });
      } catch (e) {
        console.warn("[bridge] forward failed:", e.message);
      }
    }
  }
}

if (bridgeSupabase) {
  bridgeSupabase
    .init({
      onState: (s) => {
        Object.assign(bridgeState, s, { installId: bridgeSupabase.getInstallId() });
      },
      onDispatch: (msg) => {
        // Fire-and-forget — channel events flow through .sendOutbound.
        // Route by message type:
        //   - dispatch.request: legacy direct-to-claude/cursor path
        //   - bridge.fetch.request: generic HTTP proxy (the new path
        //     the cloud chat web app uses for projects/sessions/voice)
        if (msg?.type === "bridge.fetch.request") {
          handleChannelFetch(msg).catch((e) =>
            console.warn("[bridge] fetch error:", e),
          );
        } else {
          handleChannelDispatch(msg).catch((e) =>
            console.warn("[bridge] dispatch error:", e),
          );
        }
      },
    })
    .catch((e) => {
      console.warn("[bridge] init failed (continuing in localhost-only mode):", e.message);
    });
}

// Spawn cloudflared and forward URL changes to Supabase. Started AFTER
// bridgeSupabase.init() so setTunnelUrl can publish immediately on the
// very first URL we see. cloudflared takes ~3–5s to register the tunnel
// and print the URL — the daemon's HTTP listener is up well before then,
// so there's no race with browsers hitting the tunnel before the local
// origin is ready.
if (bridgeCloudflared && bridgeSupabase) {
  bridgeCloudflared.init({
    onUrl: (url) => {
      bridgeSupabase.setTunnelUrl(url).catch((e) =>
        console.warn(`[bridge] setTunnelUrl failed: ${e.message}`),
      );
    },
  });
  // Clean shutdown — kill cloudflared when the daemon exits so we don't
  // leak orphaned tunnels on every restart cycle.
  const stopCloudflared = () => {
    try { bridgeCloudflared.shutdown(); } catch {}
  };
  process.on("SIGINT", stopCloudflared);
  process.on("SIGTERM", stopCloudflared);
  process.on("beforeExit", stopCloudflared);
}

// Bridge state introspection endpoints — used by electron/main.js to
// render the menu-bar UI (status text, "Pair this Mac" button, etc.).
app.get("/api/bridge/state", (_req, res) => {
  res.json({ ok: true, ...bridgeState });
});

app.post("/api/bridge/begin-pair", async (_req, res) => {
  if (!bridgeSupabase) {
    return res.status(503).json({ ok: false, error: "bridge disabled (LOCAL_ONLY)" });
  }
  try {
    const out = await bridgeSupabase.beginPair();
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/bridge/unpair", async (_req, res) => {
  if (!bridgeSupabase) {
    return res.status(503).json({ ok: false, error: "bridge disabled (LOCAL_ONLY)" });
  }
  try {
    await bridgeSupabase.forceUnpair();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Health + boot ────────────────────────────────────────────────

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    port: PORT,
    claudeBin: whichClaudeBin(),
    cursorAgentBin: whichCursorAgentBin(),
    claudeProjectsDir: claudeReader.CLAUDE_PROJECTS_DIR,
    cacheSize: jsonlCache.size ? jsonlCache.size() : "n/a",
    bridge: { state: bridgeState.state, paired: bridgeState.state === "connected" },
  });
});

const httpServer = app.listen(PORT, () => {
  console.log(`✓ Veronum chat localhost running at http://localhost:${PORT}`);
  console.log(`  Claude projects: ${claudeReader.CLAUDE_PROJECTS_DIR}`);
  if (bridgeSupabase) {
    console.log(`  Bridge install: ${bridgeSupabase.getInstallId().slice(0, 8)}…`);
  } else {
    console.log(`  Bridge: disabled (LOCAL_ONLY=1)`);
  }
});

// Mount live-preview WebSocket upgrade handler. Must happen AFTER
// app.listen() so we have the http.Server handle for binding 'upgrade'.
mountLivePreview(app, httpServer);
// Tunnel-friendly preview proxy: /preview/<port>/* → http://localhost:<port>/*
// with HTML <base href> rewriting. Lets phones over cloudflared open
// the same URL as the Mac browser does for localhost. WS upgrades for
// HMR are bound onto httpServer here.
mountPreviewProxy(app, httpServer);
// In-browser terminal: WS upgrade at /api/terminal/stream spawns a
// real zsh via node-pty rooted at the session's cwd. xterm.js on the
// client handles rendering. Multiple terminals = multiple WS connects.
const { mountTerminal } = require("./lib/terminal");
mountTerminal(app, httpServer);
