import { listDeployments } from '@/lib/supabase'

export async function GET() {
  const deployments = await listDeployments(30)
  return Response.json(deployments)
}
