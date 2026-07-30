import { getAllJobs } from '@/lib/jobStore'

export const runtime = 'nodejs'

export async function GET() {
  const jobs = getAllJobs()
    .filter(j => ['running', 'awaiting-approval'].includes(j.status))
    .map(j => ({
      id:              j.id,
      site:            j.site,
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
