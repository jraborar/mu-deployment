import { getAllJobs } from '@/lib/jobStore'
import { requireCaller } from '@/lib/callerAuth'

export const runtime = 'nodejs'

export async function GET(request: Request) {
  const denied = await requireCaller(request)
  if (denied) return denied

  const jobs = getAllJobs()
    .filter(j => ['running', 'awaiting-approval'].includes(j.status))
    .map(j => ({
      id:              j.id,
      site:            j.site,
      site_name:       j.site_name,
      source:          j.source,
      destination:     j.destination,
      status:          j.status,
      stages:          j.stages,
      completedStages: j.completedStages,
      currentStage:    j.currentStage,
      startedAt:       j.startedAt,
    }))
  return Response.json(jobs)
}
