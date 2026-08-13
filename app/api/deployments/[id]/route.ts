import { getDeploymentById } from '@/lib/supabase'

export const runtime = 'nodejs'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const record = await getDeploymentById(id)
  if (!record) return Response.json({ error: 'Not found' }, { status: 404 })
  return Response.json(record)
}
