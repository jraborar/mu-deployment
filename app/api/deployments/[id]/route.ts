import { getDeploymentById } from '@/lib/supabase'
import { requireCaller } from '@/lib/callerAuth'

export const runtime = 'nodejs'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await requireCaller(request)
  if (denied) return denied

  const { id } = await params
  const record = await getDeploymentById(id)
  if (!record) return Response.json({ error: 'Not found' }, { status: 404 })
  return Response.json(record)
}
