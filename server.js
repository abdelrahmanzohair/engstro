import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- Config (all secrets come from Railway Variables) ----------
const PORT = Number(process.env.PORT) || 3000;
const MB = 1024 * 1024;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
// Override only if you run a self-hosted Telegram Bot API server (needed for uploads > 50 MB).
const TELEGRAM_API_BASE = (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/$/, '');
const TELEGRAM_UPLOAD_CAP = 100 * MB;
const TELEGRAM_TIMEOUT_MS = 85_000;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
const CORS_ORIGINS = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const ALLOWED_TELEGRAM_METHODS = new Set([
  'sendMessage',
  'sendPhoto',
  'sendVideo',
  'sendAudio',
  'sendVoice',
  'sendDocument',
]);

const SYSTEM_PROMPT = `You are ENGSTRO, a senior reliability & maintenance engineer embedded in an industrial plant.
You diagnose rotating equipment, pumps, compressors, motors, gearboxes, conveyors, hydraulics, pneumatics,
boilers, HVAC, PLC/electrical panels and process instrumentation.

Respond as a concise diagnostic report in Markdown with these sections when relevant:
### Assessment — one or two sentences on the most likely condition and a severity tag: **[CRITICAL]**, **[HIGH]**, **[MEDIUM]** or **[LOW]**.
### Probable Causes — ranked bullet list.
### Checks & Measurements — concrete field checks (vibration, temperature, current, pressure, oil analysis, alignment, etc.) with typical acceptance values where useful.
### Corrective Actions — numbered steps.
### Safety — LOTO, PPE or hazard notes when applicable.

If the user is just chatting or asking a general question, answer naturally and briefly without forcing the template.
If information is missing, state assumptions and list what data would sharpen the diagnosis.
Attached media you cannot see (video, audio, binary office files) is described by metadata only — use the filename and the user's description.`;

// ---------- App ----------
const app = express();
app.disable('x-powered-by');

app.use('/api', cors({ origin: CORS_ORIGINS.length ? CORS_ORIGINS : false }));

app.get('/healthz', (_req, res) => res.json({ ok: true }));

// Static PWA from /public (headers preserved from netlify.toml)
app.use(
  express.static(path.join(__dirname, 'public'), {
    index: 'index.html',
    setHeaders(res, filePath) {
      if (filePath.endsWith(`${path.sep}sw.js`)) {
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Service-Worker-Allowed', '/');
      }
      if (filePath.endsWith(`${path.sep}manifest.json`)) {
        res.setHeader('Content-Type', 'application/manifest+json');
      }
    },
  }),
);

// ---------- Telegram proxy: POST /api/telegram/:method ----------
// Multipart bodies (photo/video/audio/document) are read as raw Buffers so the
// bytes, including the multipart boundary, reach Telegram unchanged.
app.post(
  '/api/telegram/:method',
  express.raw({ type: () => true, limit: TELEGRAM_UPLOAD_CAP + MB }),
  async (req, res) => {
    const { method } = req.params;
    if (!ALLOWED_TELEGRAM_METHODS.has(method)) {
      return res.status(400).json({ ok: false, description: 'Unsupported Telegram method' });
    }
    if (!TELEGRAM_BOT_TOKEN) {
      return res.status(503).json({
        ok: false,
        description: 'Telegram bot token is not configured on the server (TELEGRAM_BOT_TOKEN).',
      });
    }

    const headers = {};
    if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];

    try {
      const upstream = await fetch(`${TELEGRAM_API_BASE}/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
        method: 'POST',
        headers,
        body: req.body,
        signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
      });
      const data = await upstream.json().catch(() => ({ ok: false, description: 'Invalid response from Telegram' }));
      return res.status(upstream.status).json(data);
    } catch (err) {
      if (err?.name === 'TimeoutError') {
        return res.status(504).json({ ok: false, description: 'Telegram took too long to accept the upload. Try again.' });
      }
      console.error('telegram proxy error:', err?.message);
      return res.status(502).json({ ok: false, description: 'Could not reach Telegram' });
    }
  },
);

// ---------- Diagnose: POST /api/diagnose ----------
function parseDataUrl(dataUrl) {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  return match ? { mediaType: match[1], data: match[2] } : null;
}

function describeAttachment(a) {
  const mb = (a.size / MB).toFixed(2);
  const dur = a.duration ? `, ${a.duration.toFixed(1)}s` : '';
  return `[Attached ${a.kind}: "${a.name}" (${mb} MB${dur})]`;
}

app.post('/api/diagnose', express.json({ limit: '25mb' }), async (req, res) => {
  const body = req.body || {};
  const message = String(body.message || '').slice(0, 8000);
  const attachment = body.attachment || null;
  const history = (Array.isArray(body.history) ? body.history : []).slice(-10);

  const content = [];

  if (attachment) {
    const parsed = attachment.dataUrl ? parseDataUrl(attachment.dataUrl) : null;
    if (parsed && /^image\/(jpeg|png|webp|gif)$/.test(parsed.mediaType)) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: parsed.mediaType, data: parsed.data },
      });
    } else if (parsed && parsed.mediaType === 'application/pdf') {
      content.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: parsed.data },
      });
    }
    let note = describeAttachment(attachment);
    if (attachment.kind === 'video' && parsed?.mediaType.startsWith('image/')) {
      note += ' A still frame from the clip is included above.';
    }
    if (attachment.textExcerpt) {
      note += `\n--- File excerpt ---\n${String(attachment.textExcerpt).slice(0, 20000)}\n--- End excerpt ---`;
    }
    content.push({ type: 'text', text: note });
  }

  content.push({ type: 'text', text: message || 'Please analyse the attached file and give a diagnostic report.' });

  // Build alternating-role history (Anthropic requires alternation)
  const messages = [];
  for (const h of history) {
    if (!h || !h.text) continue;
    const role = h.role === 'assistant' ? 'assistant' : 'user';
    const last = messages[messages.length - 1];
    if (last && last.role === role && typeof last.content === 'string') {
      last.content += `\n\n${h.text}`;
    } else {
      messages.push({ role, content: String(h.text).slice(0, 6000) });
    }
  }
  if (messages[0]?.role === 'assistant') messages.shift();
  if (messages[messages.length - 1]?.role === 'user') {
    const prev = messages.pop();
    content.unshift({ type: 'text', text: String(prev.content) });
  }
  messages.push({ role: 'user', content });

  try {
    const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY
    const result = await anthropic.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 1800,
      system: SYSTEM_PROMPT,
      messages,
    });
    const text = result.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    return res.json({ report: text || 'No report generated.' });
  } catch (err) {
    console.error('diagnose failed:', err?.message);
    return res
      .status(502)
      .json({ error: 'The diagnostic engine is temporarily unavailable. Please try again.' });
  }
});

// ---------- API 404 + error handling ----------
app.use('/api', (_req, res) => res.status(404).json({ ok: false, error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  const isTelegram = req.path.startsWith('/api/telegram');
  if (err.type === 'entity.too.large') {
    const msg = 'Telegram uploads are limited to 100 MB.';
    return isTelegram
      ? res.status(413).json({ ok: false, description: msg })
      : res.status(413).json({ error: msg });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }
  console.error('unhandled error:', err?.message);
  return res.status(err.status || 500).json(
    isTelegram ? { ok: false, description: 'Server error' } : { error: 'Server error' },
  );
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`ENGSTRO listening on :${PORT}`);
  if (!TELEGRAM_BOT_TOKEN) console.warn('WARN: TELEGRAM_BOT_TOKEN is not set');
  if (!process.env.ANTHROPIC_API_KEY) console.warn('WARN: ANTHROPIC_API_KEY is not set');
});

// Graceful shutdown on Railway redeploys
const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

