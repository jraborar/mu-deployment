import { type NextRequest } from 'next/server'
import { getJob } from '@/lib/jobStore'
import { verifySignature } from '@/lib/slack'

export const runtime = 'nodejs'

// Slack Interactivity endpoint — handles Approve/Reject button clicks on the
// deployment approval message (action_ids deployment_approve/deployment_reject;
// the button `value` carries {jobId, approved}). Point the Slack app's
// "Interactivity & Shortcuts → Request URL" at /api/slack/interact.
// Mirrors /api/pumble/interact but verifies with SLACK_SIGNING_SECRET.
export async function POST(request: NextRequest) {
  const rawBody   = await request.text()
  const timestamp = request.headers.get('x-slack-request-timestamp') ?? ''
  const signature = request.headers.get('x-slack-signature') ?? ''
  const secret    = process.env.SLACK_SIGNING_SECRET ?? ''

  // Fails CLOSED, matching lib/callerAuth.ts and the same fix mu-staging took
  // in its #217. This was `if (secret && !verify…)`, which SKIPPED verification
  // entirely when SLACK_SIGNING_SECRET was absent — and it is not set on this
  // service, so the route was in fact unauthenticated in production. An
  // unsigned probe returned 200. The handler below resolves a pending approval,
  // i.e. releases a deployment to a customer environment.
  //
  // Barely exploitable (a caller needs an unguessable jobId AND a job sitting
  // in pendingApproval) and Slack does not call this route — SLACK_APP_TOKEN is
  // set, so interactions arrive over Socket Mode. But it is reachable, it
  // writes, and "it verifies its own signature" is the stated reason this route
  // is excluded from requireCaller, so that reason has to be true rather than
  // conditional on a variable nobody set.
  if (!secret || !verifySignature(rawBody, timestamp, signature, secret)) {
    return new Response('Unauthorized', { status: 401 })
  }

  // Slack sends interactions URL-encoded: payload=<json>
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
    // Already resolved, expired on redeploy, or handled in-app — ack so Slack doesn't retry.
    return new Response('OK', { status: 200 })
  }

  job.pendingApproval.resolve(Boolean(approved))
  job.pendingApproval = null
  console.log(`[slack] Job ${jobId} ${approved ? 'approved' : 'rejected'} via Slack button`)

  return new Response('OK', { status: 200 })
}
