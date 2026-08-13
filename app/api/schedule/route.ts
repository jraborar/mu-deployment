import { createSchedule, listSchedules, cancelSchedule, updateSchedule } from '@/lib/supabase'
import { broadcastMessage, buildScheduledBlocks } from '@/lib/slack'
import { run } from '@/lib/terminus'

export const runtime = 'nodejs'

const INPUT_RE = /^[a-z0-9.\-_]+$/i

function cleanTerminusOutput(raw: string): string {
  return raw.split('\n').filter(l => !/^\s*(Deprecated|Warning|Notice|PHP):/i.test(l)).join('\n').trim()
}

async function resolveSiteName(site: string): Promise<string | undefined> {
  if (!INPUT_RE.test(site)) return undefined
  try {
    const token = process.env.TERMINUS_TOKEN
    if (token) await run(`terminus auth:login --machine-token="${token}" 2>&1`)
    const result = await run(`terminus site:info ${site} --format=json 2>&1`)
    const cleaned = cleanTerminusOutput(result.stdout)
    const start = cleaned.search(/[{[]/)
    if (start === -1) return undefined
    const data = JSON.parse(cleaned.slice(start))
    return data?.label ?? data?.name ?? undefined
  } catch {
    return undefined
  }
}

export async function GET() {
  const schedules = await listSchedules()
  return Response.json(schedules)
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null)
  if (!body) return Response.json({ error: 'Invalid JSON' }, { status: 400 })

  const { site, source, destination, scheduled_for, notes, consultant } = body
  if (!site || !source || !destination || !scheduled_for) {
    return Response.json({ error: 'Missing required fields' }, { status: 400 })
  }
  if (!['dev', 'test', 'live'].includes(destination)) {
    return Response.json({ error: 'Invalid destination' }, { status: 400 })
  }

  const site_name = await resolveSiteName(site)
  await createSchedule({ site, site_name, source, destination, scheduled_for, notes, consultant })
  void broadcastMessage(
    buildScheduledBlocks(source, destination, site_name ?? site, scheduled_for, notes),
    `Deployment scheduled: ${source} → ${destination} on ${site_name ?? site}`,
  )
  return Response.json({ ok: true })
}

export async function PATCH(request: Request) {
  const body = await request.json().catch(() => null)
  if (!body) return Response.json({ error: 'Invalid JSON' }, { status: 400 })
  const { id, scheduled_for, notes, destination } = body
  if (!id || !scheduled_for) return Response.json({ error: 'Missing id or scheduled_for' }, { status: 400 })
  const updates: Record<string, string> = { scheduled_for, notes }
  if (destination && ['dev', 'test', 'live'].includes(destination)) updates.destination = destination
  await updateSchedule(id, updates)
  return Response.json({ ok: true })
}

export async function DELETE(request: Request) {
  const { id } = await request.json().catch(() => ({}))
  if (!id) return Response.json({ error: 'Missing id' }, { status: 400 })
  await cancelSchedule(id)
  return Response.json({ ok: true })
}
