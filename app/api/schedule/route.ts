import { createSchedule, listSchedules, cancelSchedule } from '@/lib/supabase'

export async function GET() {
  const schedules = await listSchedules()
  return Response.json(schedules)
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null)
  if (!body) return Response.json({ error: 'Invalid JSON' }, { status: 400 })

  const { site, source, destination, scheduled_for, notes } = body
  if (!site || !source || !destination || !scheduled_for) {
    return Response.json({ error: 'Missing required fields' }, { status: 400 })
  }
  if (!['dev', 'test', 'live'].includes(destination)) {
    return Response.json({ error: 'Invalid destination' }, { status: 400 })
  }

  await createSchedule({ site, source, destination, scheduled_for, notes })
  return Response.json({ ok: true })
}

export async function DELETE(request: Request) {
  const { id } = await request.json().catch(() => ({}))
  if (!id) return Response.json({ error: 'Missing id' }, { status: 400 })
  await cancelSchedule(id)
  return Response.json({ ok: true })
}
