import { markScheduleCustomerDeployed } from '@/lib/supabase'

export const runtime = 'nodejs'

export async function POST(request: Request) {
  const body = await request.json().catch(() => null)
  if (!body) return Response.json({ error: 'Invalid JSON' }, { status: 400 })

  const { id, completed_at } = body
  if (!id || !completed_at) return Response.json({ error: 'Missing id or completed_at' }, { status: 400 })

  const result = await markScheduleCustomerDeployed(id, completed_at)
  if (!result.ok) return Response.json({ error: result.error }, { status: 400 })
  return Response.json({ ok: true })
}
