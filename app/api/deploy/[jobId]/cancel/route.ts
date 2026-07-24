import { getJob } from '@/lib/jobStore'

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

  job.cancelRequested = true

  // If waiting for approval, resolve it so the job loop unblocks immediately
  if (job.pendingApproval) {
    job.pendingApproval.resolve(false)
    job.pendingApproval = null
  }

  return Response.json({ ok: true })
}
