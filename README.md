# Veronum Bridge

The Mac side of Veronum — a small menu-bar daemon that runs your local Claude Code and Cursor sessions through a chat UI you can reach from any device.

Pair the bridge once to your account at thetoolswebsite.com; from then on you can open chat.thetoolswebsite.com on any phone or laptop and talk to your actual coding sessions — voice or text — while the work happens on your Mac.

## What it does

- Reads your local `~/.claude/projects/*.jsonl` to enumerate your existing Claude Code chat history (no MCP, just direct file reads).
- Spawns `claude --resume <session>` locally with the same flags you'd use yourself (`--permission-mode bypassPermissions`, model + effort overrides, full tool surface).
- Same for `cursor-agent` sessions.
- Exposes an OpenAI Realtime + push-to-talk voice agent so you can drive your sessions hands-free (e.g. from a car).
- (Phase 2) Connects out to the Veronum cloud relay over WebSocket so you can reach your Mac from any browser, anywhere.

## Local development

```bash
npm install
npm run dev            # node --watch server.js — vanilla localhost on :3001
npm run electron:dev   # launches the menu-bar app pointing at the local server
```

You'll need a `.env` at the project root with:

```
OPENAI_API_KEY=sk-...
ELEVENLABS_API_KEY=...                     # optional, only if using EL voices
VERONUM_ELEVENLABS_AGENT_ID=agent_...      # optional
```

## Build a signed, notarized DMG

The signing identity and notarization keychain profile match veronum-overlay:

- Apple Developer ID: `Developer ID Application: Dylan Wain (YNZLTKWB83)`
- Notarization profile: `veronum-notary` (stored in macOS keychain via `xcrun notarytool store-credentials`)

```bash
npm run package:mac           # full universal build, signed + notarized (~10-15 min)
npm run package:mac:fast      # skip notarization for local iteration (~2 min)
npm run publish:mac           # build + upload to a GitHub release on DylanWain/veronum-bridge
```

Output: `dist/Veronum-Bridge-<version>-universal.dmg`.

## Code layout

```
electron/main.js                Menu-bar wrapper. Loads server.js, owns the Tray.
server.js                       Express app — session listing, dispatch, voice routes.
lib/jsonlCache.js               LRU cache over Claude session JSONL files.
lib/claudeReader.js             Find / parse the JSONL on disk.
lib/cursor.js                   Same, for Cursor Agent sessions.
bin/chat-history                Python helper Claude can call to answer
                                meta-history questions ("first message", counts).
public/                         The dark mobile-first web UI (vanilla HTML/JS).
build/                          App icon + entitlements + DMG background.
scripts/notarize-afterSign.js   electron-builder hook → @electron/notarize.
```

## Architecture status

- ✅ Localhost-only chat works (server.js, dark mobile UI, voice agent).
- ✅ Mac packaging works (signed + notarized DMG via this repo).
- ⏳ Cloud relay (`apps/server` in the T3 Tools monorepo) — daemon needs to
  open an outbound WebSocket; relay needs to forward dispatch over it.
- ⏳ Pair-by-magic-link flow using the registered `veronum-bridge://` URL scheme.
- ⏳ Stripe usage metering: emit `api_cost_raw_cents` events from each
  Claude dispatch, mirroring veronum-overlay's pattern.

## License

Proprietary — © Dylan Wain. Not open source.
