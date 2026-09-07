import { type NextRequest } from 'next/server'
import { getJob } from '@/lib/jobStore'
import { verifySignature } from '@/lib/slack'

export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  const rawBody   = await request.text()
  const timestamp = request.headers.get('x-slack-request-timestamp') ?? ''
  const signature = request.headers.get('x-slack-signature') ?? ''
  const secret    = process.env.PUMBLE_SIGNING_SECRET ?? ''

  // Fails CLOSED — the same fix /api/slack/interact took, which this route was
  // missed by even though the comment there says it mirrors this one.
  //
  // `if (secret && !verify…)` skipped verification entirely when the secret was
  // absent, and no PUMBLE_* variable is set on this service at all — so this was
  // an unauthenticated POST in production. It is worse than the Slack twin was,
  // because the jobId it needs is not really unguessable: GET /api/jobs is open
  // and lists in-flight jobs with their ids and statuses. Poll it during a
  // deployment, read the id of one sitting in awaiting-approval, POST it here,
  // and the approval gate opens with no human involved.
  //
  // Nothing legitimate calls this: isPumbleConfigured() is false without
  // PUMBLE_WEBHOOK_URL, so Pumble is not wired up here and never sends
  // interactions. Failing closed costs nothing and removes the bypass. (Closing
  // GET /api/jobs is the other half and is tracked separately.)
  if (!secret || !verifySignature(rawBody, timestamp, signature, secret)) {
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
