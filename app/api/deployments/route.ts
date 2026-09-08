import { listDeployments } from '@/lib/supabase'
import { requireCaller } from '@/lib/callerAuth'

export const runtime = 'nodejs'

export async function GET(request: Request) {
  const denied = await requireCaller(request)
  if (denied) return denied

  const deployments = await listDeployments(30)
  return Response.json(deployments)
}
