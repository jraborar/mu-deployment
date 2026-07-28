import { type NextRequest } from 'next/server'
import { getJob } from '@/lib/jobStore'
import { verifySignature } from '@/lib/slack'

export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  const rawBody   = await request.text()
  const timestamp = request.headers.get('x-slack-request-timestamp') ?? ''
  const signature = request.headers.get('x-slack-signature') ?? ''
  const secret    = process.env.PUMBLE_SIGNING_SECRET ?? ''

  // Skip verification if no secret is configured (dev/testing only)
  if (secret && !verifySignature(rawBody, timestamp, signature, secret)) {
    return new Response('Unauthorized', { status: 401 })
  }

  // Pumble sends interactions as URL-encoded: payload=<json>
  const params  = new URLSearchParams(rawBody)
  const payload = JSON.parse(params.get('payload') ?? '{}')

  const action = payload?.actions?.[0]
  if (!action?.value) return new Response('OK', { status: 200 })

  let parsed: { jobId?: string; approved?: boolean }
  try {
    parsed = JSON.parse(action.value)
  } catch {
    return new Response('OK', { status: 200 })
  }

  const { jobId, approved } = parsed
  if (!jobId) return new Response('OK', { status: 200 })

  const job = getJob(jobId)
  if (!job?.pendingApproval) {
    return new Response('OK', { status: 200 })
  }

  job.pendingApproval.resolve(Boolean(approved))
  job.pendingApproval = null
  console.log(`[pumble] Job ${jobId} ${approved ? 'approved' : 'rejected'} via Pumble`)

  return new Response('OK', { status: 200 })
}
