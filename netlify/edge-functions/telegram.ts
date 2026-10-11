import type { Config, Context } from '@netlify/edge-functions'

const ALLOWED_METHODS = new Set(['sendMessage', 'sendPhoto', 'sendVideo', 'sendAudio', 'sendVoice', 'sendDocument'])
const TELEGRAM_UPLOAD_CAP = 100 * 1024 * 1024 // رفع الحد إلى 100 ميجا كما طلبت

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

  const declared = Number(req.headers.get('content-length') || 0)
  if (declared > TELEGRAM_UPLOAD_CAP + 1024 * 1024) {
    return Response.json({ ok: false, description: 'Telegram bots can only upload files up to 100 MB.' }, { status: 413 })
  }

  try {
    // قراءة الـ Headers الأصلية كاملة مع الـ Boundary الخاص بـ FormData
    const headers = new Headers()
    const contentType = req.headers.get('content-type')
    if (contentType) {
      headers.set('content-type', contentType)
    }

    // قراءة الجسم الثنائي (ArrayBuffer) لضمان عدم تلف الملفات أو الصوتيات
    const body = await req.arrayBuffer()

    const upstream = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(55_000), // رفع المهلة الزمنية لـ 55 ثانية لملفات الـ PDF الكبيرة
    })

    const data = await upstream.json().catch(() => ({ ok: false, description: 'Invalid response from Telegram' }))
    return Response.json(data, { status: upstream.status })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      return Response.json({ ok: false, description: 'Telegram took too long to accept the upload. Try again.' }, { status: 504 })
    }
    return Response.json({ ok: false, description: 'Could not reach Telegram' }, { status: 502 })
  }
}

export const config: Config = {
  path: '/api/telegram/:method',
}
