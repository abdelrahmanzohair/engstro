import Anthropic from '@anthropic-ai/sdk'
import type { Config } from '@netlify/functions'

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
Attached media you cannot see (video, audio, binary office files) is described by metadata only — use the filename and the user's description.`

type Attachment = {
  kind: 'image' | 'video' | 'audio' | 'document'
  name: string
  size: number
  mime?: string
  duration?: number
  dataUrl?: string // downscaled image or small PDF
  textExcerpt?: string // for txt/log/csv
}

type HistoryItem = { role: 'user' | 'assistant'; text: string }

function parseDataUrl(dataUrl: string) {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl)
  return match ? { mediaType: match[1], data: match[2] } : null
}

function describe(a: Attachment) {
  const mb = (a.size / (1024 * 1024)).toFixed(2)
  const dur = a.duration ? `, ${a.duration.toFixed(1)}s` : ''
  return `[Attached ${a.kind}: "${a.name}" (${mb} MB${dur})]`
}

export default async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  let body: { message?: string; attachment?: Attachment | null; history?: HistoryItem[] }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const message = (body.message || '').slice(0, 8000)
  const attachment = body.attachment || null
  const history = (body.history || []).slice(-10)

  const content: Anthropic.ContentBlockParam[] = []

  if (attachment) {
    const parsed = attachment.dataUrl ? parseDataUrl(attachment.dataUrl) : null
    if (parsed && /^image\/(jpeg|png|webp|gif)$/.test(parsed.mediaType)) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: parsed.mediaType as 'image/jpeg', data: parsed.data },
      })
    } else if (parsed && parsed.mediaType === 'application/pdf') {
      content.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: parsed.data },
      })
    }
    let note = describe(attachment)
    if (attachment.kind === 'video' && parsed?.mediaType.startsWith('image/')) note += ' A still frame from the clip is included above.'
    if (attachment.textExcerpt) {
      note += `\n--- File excerpt ---\n${attachment.textExcerpt.slice(0, 20000)}\n--- End excerpt ---`
    }
    content.push({ type: 'text', text: note })
  }

  content.push({ type: 'text', text: message || 'Please analyse the attached file and give a diagnostic report.' })

  const messages: Anthropic.MessageParam[] = []
  for (const h of history) {
    if (!h.text) continue
    const role = h.role === 'assistant' ? 'assistant' : 'user'
    // Anthropic requires alternating roles; merge consecutive turns
    const last = messages[messages.length - 1]
    if (last && last.role === role && typeof last.content === 'string') {
      last.content += `\n\n${h.text}`
    } else {
      messages.push({ role, content: h.text.slice(0, 6000) })
    }
  }
  if (messages[0]?.role === 'assistant') messages.shift()
  if (messages[messages.length - 1]?.role === 'user') {
    const prev = messages.pop()!
    content.unshift({ type: 'text', text: String(prev.content) })
  }
  messages.push({ role: 'user', content })

  try {
    const anthropic = new Anthropic()
    const result = await anthropic.messages.create({
      model: 'claude-sonnet-5-5',
      max_tokens: 1800,
      system: SYSTEM_PROMPT,
      messages,
    })
    const text = result.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim()
    return Response.json({ report: text || 'No report generated.' })
  } catch (err) {
    console.error('diagnose failed', err)
    return Response.json({ error: 'The diagnostic engine is temporarily unavailable. Please try again.' }, { status: 502 })
  }
}

export const config: Config = {
  path: '/api/diagnose',
}
