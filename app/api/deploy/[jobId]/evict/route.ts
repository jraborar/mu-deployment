import { getJob } from '@/lib/jobStore'
import { finalizeDeploymentRecord } from '@/lib/supabase'

export const runtime = 'nodejs'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params
  const job = getJob(jobId)

  if (!job) return Response.json({ error: 'Job not found' }, { status: 404 })
  if (['completed', 'failed', 'paused'].includes(job.status)) {
    return Response.json({ error: 'Job already finished' }, { status: 409 })
  }

  const entry = { type: 'log' as const, logType: 'error' as const, message: 'Job force-stopped by administrator', ts: Date.now() }
  job.logs.push(entry)
  job.status = 'failed'
  job.emitter.emit('event', entry)
  job.emitter.emit('event', { type: 'complete', status: 'failed' })
  job.emitter.emit('done')

  await finalizeDeploymentRecord(job.id, {
    stages_completed: job.completedStages,
    status: 'failed',
    completed_at: new Date().toISOString(),
    logs: job.logs,
    site_name: job.site_name,
  })

  return Response.json({ ok: true })
}
