import { timingSafeEqual } from 'node:crypto'
import { createClient } from '@/utils/supabase/server'

/**
 * Who is allowed to call a mutating API route.
 *
 * `proxy.ts` lists `/api/` among its public paths with the comment "API routes
 * handle their own auth or are internal-only". Eleven of fifteen mutating
 * handlers checked nothing at all, and it was confirmed against production:
 * POST /api/deploy (which runs dev→test→live on a customer site),
 * POST /api/approve/[jobId], the cancel and evict routes,
 * POST/PATCH/DELETE /api/schedule, and DELETE /api/sites/[site] were reachable
 * by anyone who could resolve the host. The delete answered 200.
 *
 * This is the same fix mu-staging took in its own #217; the shape is
 * deliberately identical so the two apps stay easy to reason about together.
 *
 * Two kinds of caller are legitimate, so this accepts either:
 *
 *   1. A signed-in browser session — this app's own UI calls these
 *      same-origin from app/page.tsx with the auth cookie attached.
 *   2. A shared secret in `authorization: Bearer …` — mu-staging's
 *      prebookDeployment and reconcileDeployment call POST/PATCH/DELETE
 *      /api/schedule server-to-server and have no cookie to send.
 *
 * ORDER MATTERS, and the staging half is already done: mu-staging sends this
 * header whenever MU_ACTION_SECRET is set (its #223). Deploying this before
 * that lands would make every staging run fail to pre-book its deploy.
 *
 * DELIBERATELY NOT GATED:
 *
 *   - `/api/cron/trigger` and `/api/admin/backfill-slack` already check their
 *     own secret.
 *   - `/api/pumble/interact` and `/api/slack/interact` verify their own
 *     signature; neither presents a cookie or our secret. (The Slack one only
 *     verifies properly as of the fail-closed fix in this same change — it was
 *     skipping verification entirely whenever SLACK_SIGNING_SECRET was absent,
 *     which it is on this service.)
 *   - Every GET. mu-staging reads GET /api/schedule with no credential, so
 *     gating reads means changing that app too — worth doing, as its own
 *     change.
 *
 * FAILS CLOSED when MU_ACTION_SECRET is unset: the secret branch cannot match
 * and the session branch still gates. An unset variable costs mu-staging its
 * deploy pre-booking (401); it does not leave the route open.
 */

/** Constant-time compare that does not leak length through early return. */
function secretMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  if (a.length !== b.length) {
    // Still burn a comparison of equal-length buffers so the work is constant.
    timingSafeEqual(a, a)
    return false
  }
  return timingSafeEqual(a, b)
}

export async function requireCaller(request: Request): Promise<Response | null> {
  const secret = process.env.MU_ACTION_SECRET
  if (secret) {
    const presented = request.headers.get('authorization')
    if (presented && secretMatches(presented, `Bearer ${secret}`)) return null
  }

  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (user) return null
  } catch {
    // A broken Supabase call must not become an open door.
  }

  return Response.json(
    {
      error:
        'Sign in, or call with the MU_ACTION_SECRET bearer token. ' +
        'This endpoint deploys to real environments, so it is no longer anonymous.',
    },
    { status: 401 },
  )
}
