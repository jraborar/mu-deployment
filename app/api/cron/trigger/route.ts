import { runDueSchedules } from '@/lib/scheduler'

export const runtime = 'nodejs'

// Singleton timer — starts on first request, keeps running for the life of the process.
// This avoids instrumentation.ts Edge-runtime bundling warnings.
let schedulerStarted = false

function startScheduler() {
  if (schedulerStarted) return
  schedulerStarted = true

  const INTERVAL_MS = 60_000
  async function tick() {
    try {
      const result = await runDueSchedules()
      if (result.triggered > 0) {
        console.log(`[scheduler] Triggered ${result.triggered} deployment(s)`)
      }
    } catch (err) {
      console.error('[scheduler] Error:', err)
    }
    setTimeout(tick, INTERVAL_MS)
  }
  setTimeout(tick, INTERVAL_MS)
  console.log('[scheduler] Started — checking for due deployments every minute')
}

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

  startScheduler()
  const result = await runDueSchedules()
  return Response.json(result)
}

// GET — used by the dev server to auto-start the scheduler on first page load
export async function GET() {
  startScheduler()
  return Response.json({ started: schedulerStarted })
}
