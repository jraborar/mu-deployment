import { getJob } from '@/lib/jobStore'

export const runtime = 'nodejs'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params
  const job = getJob(jobId)

  if (!job) return Response.json({ error: 'Job not found' }, { status: 404 })
  if (!job.pendingApproval) return Response.json({ error: 'No pending approval' }, { status: 409 })

  const body = await request.json().catch(() => ({}))
  const approved = Boolean(body.approved)

  job.pendingApproval.resolve(approved)
  job.pendingApproval = null

  return Response.json({ ok: true, approved })
}
