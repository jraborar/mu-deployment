import { requireCaller } from '@/lib/callerAuth'

export const runtime = 'nodejs'

/**
 * Proxy for mu-wp-staging's upcoming-windows list, so the browser reads it
 * same-origin instead of cross-origin.
 *
 * Sends `authorization: Bearer $MU_ACTION_SECRET` when the variable is set.
 * mu-wp-staging's GETs are open today and ignore the header; this is the inert
 * half of gating them, so the two apps can roll out independently.
 *
 * NOTE the fail-silent below: a non-ok response becomes an empty array with a
 * 200, so the UI renders "nothing upcoming" rather than an error. That is
 * deliberate — a staging outage should not break this app's dashboard — but it
 * would also hide a 401 during the rollout, so log it.
 */
export async function GET(request: Request) {
  const denied = await requireCaller(request)
  if (denied) return denied

  const stagingUrl = process.env.MU_STAGING_URL
  if (!stagingUrl) {
    return Response.json({ error: 'MU_STAGING_URL not configured' }, { status: 503 })
  }

  const secret = process.env.MU_ACTION_SECRET

  try {
    const res = await fetch(`${stagingUrl}/api/upcoming`, {
      next: { revalidate: 60 }, // cache 1 min
      headers: secret ? { authorization: `Bearer ${secret}` } : {},
    })
    if (!res.ok) {
      console.error(`[staging-upcoming] mu-wp-staging returned ${res.status} — showing an empty list`)
      return Response.json([], { status: 200 })
    }
    const data = await res.json()
    return Response.json(data)
  } catch (err) {
    console.error('[staging-upcoming] fetch failed:', err instanceof Error ? err.message : String(err))
    return Response.json([], { status: 200 })
  }
}
