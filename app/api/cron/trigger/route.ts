import { runDueSchedules } from '@/lib/scheduler'
import { ensureStarted, isSchedulerStarted } from '@/lib/startup'
import { requireCaller } from '@/lib/callerAuth'

export const runtime = 'nodejs'

// The scheduler and the rest of process startup now live in lib/startup.ts and
// are started at boot by instrumentation.node.ts. The calls below stay as an
// idempotent fallback for the case where instrumentation did not run.

// Called by GitHub Actions, system cron, or manually:
//   curl -X POST http://localhost:3001/api/cron/trigger
// Set CRON_SECRET env var to require authorization in production.
export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET
  if (secret) {
    const auth = request.headers.get('authorization')
    if (auth !== `Bearer ${secret}`) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  await ensureStarted()
  const result = await runDueSchedules()
  return Response.json(result)
}

// GET — kept so the dev server (and app/page.tsx on load) can force startup.
export async function GET(request: Request) {
  const denied = await requireCaller(request)
  if (denied) return denied

  await ensureStarted()
  return Response.json({ started: isSchedulerStarted() })
}
