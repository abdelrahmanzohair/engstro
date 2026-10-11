import type { Config, Context } from '@netlify/edge-functions'

// Server-side relay to the Telegram Bot API. The bot token lives only in the
// TELEGRAM_BOT_TOKEN environment variable so it never ships to the browser.
// Runs at the edge so large multipart uploads avoid the serverless body cap.
const ALLOWED_METHODS = new Set(['sendMessage', 'sendPhoto', 'sendVideo', 'sendAudio', 'sendVoice', 'sendDocument'])
const TELEGRAM_UPLOAD_CAP = 50 * 1024 * 1024

export default async (req: Request, context: Context) => {
  if (req.method !== 'POST') {
    return Response.json({ ok: false, description: 'Method not allowed' }, { status: 405 })
  }

  const method = context.params.method
  if (!method || !ALLOWED_METHODS.has(method)) {
    return Response.json({ ok: false, description: 'Unsupported Telegram method' }, { status: 400 })
  }

  const token = Netlify.env.get('TELEGRAM_BOT_TOKEN')
  if (!token) {
    return Response.json(
      { ok: false, description: 'Telegram bot token is not configured on the server (TELEGRAM_BOT_TOKEN).' },
      { status: 503 },
    )
  }

  // Keep the browser-generated multipart boundary intact.
  const headers = new Headers()
  const contentType = req.headers.get('content-type')
  if (contentType) headers.set('content-type', contentType)

  const declared = Number(req.headers.get('content-length') || 0)
  if (declared > TELEGRAM_UPLOAD_CAP + 1024 * 1024) {
    return Response.json({ ok: false, description: 'Telegram bots can only upload files up to 50 MB.' }, { status: 413 })
  }

  try {
    // Deno forwards a streamed body with chunked transfer-encoding and drops
    // Content-Length, which the Bot API handles poorly for multipart uploads
    // (large documents stall until timeout). Buffering the ≤ 50 MB body gives
    // Telegram a fixed-length request it accepts reliably.
    const body = await req.arrayBuffer()
    const upstream = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers,
      body,
      // Edge responses must start within 40 s, so fail clearly just before that.
      signal: AbortSignal.timeout(38_000),
    })
    const data = await upstream.json().catch(() => ({ ok: false, description: 'Invalid response from Telegram' }))
    return Response.json(data, { status: upstream.status })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      return Response.json({ ok: false, description: 'Telegram took too long to accept the upload. Try again on a faster connection.' }, { status: 504 })
    }
    return Response.json({ ok: false, description: 'Could not reach Telegram' }, { status: 502 })
  }
}

export const config: Config = {
  path: '/api/telegram/:method',
}
