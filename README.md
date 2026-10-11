# ENGSTRO

An industrial-grade Progressive Web App for plant maintenance and machinery diagnostics. Technicians describe a fault in a ChatGPT-style console — optionally attaching a photo, a ≤10 s video clip, a ≤30 s voice note or a maintenance document — and receive a structured engineering report (assessment, severity, probable causes, checks, corrective actions, safety). Queries, attachments and reports can be delivered to the user's Telegram chat, and the app runs as a Telegram Web App or an installable standalone PWA.

## Features

- **Diagnostic chat feed** — scrollable, auto-scrolling log of queries and AI reports with severity badges, copy and "send to Telegram" actions. Saved on the device.
- **Optional attachments** — photos, video (max 10 s), audio files (max 30 s), live voice recorder with waveform (auto-stops at 30 s), and documents (PDF, Word, Excel/CSV, TXT/LOG) up to 100 MB. Validation errors appear as floating toasts.
- **Telegram integration** — Telegram Web App SDK; `chat_id` is read from `Telegram.WebApp.initDataUnsafe.user.id`, with a manual fallback in the header's Telegram Link settings. Uses the Bot API `sendMessage`, `sendPhoto`, `sendVideo`, `sendAudio` and `sendDocument` methods.
- **Industrial glassmorphism** — Night (#0F0F12 / #1A1A22 / #FFD700) and Day (#F8F9FA / #FFFFFF / #F59E0B) themes with an animated sun/moon switch, frosted glass header and composer.
- **PWA** — `manifest.json`, offline app-shell service worker (`sw.js`), and an "Install App" button driven by `beforeinstallprompt` (hidden in standalone mode).

## Tech

- Plain HTML, CSS and JavaScript (`public/`) — no front-end build step
- Node.js + Express (`server.js`) — serves `public/`, relays `/api/telegram/:method` to the Telegram Bot API with the token kept server-side, and runs the `/api/diagnose` engine (Claude, via `ANTHROPIC_API_KEY`)

## Configuration

Set these as environment variables on the Railway service (**Variables**):

| Variable | Purpose |
|----------|---------|
| `TELEGRAM_BOT_TOKEN` | Token from @BotFather. Read only by the server; never shipped to the browser. |
| `ANTHROPIC_API_KEY` | Anthropic API key for `/api/diagnose`. |
| `ANTHROPIC_MODEL` | Optional. Defaults to `claude-sonnet-5-5`. |
| `CORS_ORIGINS` | Optional. Comma-separated origins allowed to call `/api`. |
| `TELEGRAM_API_BASE` | Optional. Self-hosted Bot API URL (needed for uploads > 50 MB). |

Users must press **Start** on the bot once before it can message them.

## Run locally

```bash
npm install
TELEGRAM_BOT_TOKEN=... ANTHROPIC_API_KEY=... npm start
```

Then open http://localhost:3000.

## Limits worth knowing

- Telegram's Bot API accepts uploads up to 50 MB; larger files (up to the app's 100 MB limit) are still analysed by name/metadata but are not forwarded.
- The diagnostic engine reads images, a still frame from videos, PDFs up to 3 MB, and text excerpts from TXT/LOG/CSV. Audio and Office files are described to it by metadata.
