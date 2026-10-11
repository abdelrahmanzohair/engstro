# AGENTS.md — ENGSTRO

## Architecture
- `public/` — the entire front end, served as static files (served by Express `server.js`). No bundler.
  - `index.html` — markup: glass header (gear brand, System Online pulse, Install App, Telegram Link settings drawer, theme switch), chat feed, composer, hidden file inputs.
  - `styles.css` — design tokens as CSS variables per `[data-theme='dark'|'light']`. Use the tokens (`--accent`, `--card`, `--glass`…) rather than hard-coded colours.
  - `app.js` — single IIFE: Telegram Web App init, theme, PWA install, toasts, attachment validation, voice recorder, minimal safe Markdown renderer, chat send flow, localStorage log.
  - `manifest.json`, `sw.js`, `icons/` — PWA. Bump `VERSION` in `sw.js` when shell files change materially.
- `server.js` — Express server: static `public/`, `GET /healthz`, and `POST /api/telegram/:method` relay; whitelists six send methods (incl. `sendVoice`). Multipart bodies are buffered in memory (≤ 100 MB) and forwarded with a fixed length, because Telegram stalls on chunked multipart.
- `server.js` — `POST /api/diagnose`; Anthropic SDK with `ANTHROPIC_API_KEY` (model `ANTHROPIC_MODEL`, default `claude-sonnet-5-5`). Accepts `{ message, attachment, history }`.

## Non-obvious decisions
- **The Telegram bot token is never in client code or the repo.** It lives in the `TELEGRAM_BOT_TOKEN` env var and is used only by the server relay. Keep it that way — a token in browser JS lets anyone take over the bot.
- Client limits: 100 MB any file, video ≤ 10 s, audio ≤ 30 s (duration read from media metadata; recorder auto-stops). Telegram itself caps bot uploads at 50 MB, so larger files skip forwarding with a toast.
- The AI payload is kept small to fit the function body limit: images downscaled to 1280 px JPEG, one video frame, PDFs ≤ 1 MB inline as base64 (larger PDFs go to the AI as metadata only), text excerpts ≤ 20 k chars.
- Chat history is stored per device in localStorage (`engstro:log`), last 60 entries, without binary data.
- Recorded voice notes are exported as OGG/Opus (native, or remuxed from WebM without re-encoding) or 16 kHz WAV as a fallback, and are sent via `sendVoice` with the `voice` field, so n8n's Telegram Voice trigger and Groq Whisper pick them up. Uploaded audio files still use `sendAudio`.
- `chat_id` priority: Telegram WebApp user id → manual value in localStorage (`engstro:chatId`).

## Conventions
- Vanilla ES2020, no dependencies in the browser. Build DOM with `textContent` for user data; only `renderMarkdown` output (escaped first) goes through `innerHTML`.
- Server routes are plain Express handlers in `server.js`.
