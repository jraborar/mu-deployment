import { runDueSchedules } from '@/lib/scheduler'
import { getAllJobs } from '@/lib/jobStore'
import { finalizeDeploymentRecord, cleanupStaleRunningRecords, listSchedules } from '@/lib/supabase'
import { broadcastMessage, buildScheduledBlocks, isSlackConfigured, isPumbleConfigured } from '@/lib/slack'

export const runtime = 'nodejs'

// All singletons — start on first request, persist for the life of the process.
// This avoids instrumentation.ts Edge-runtime bundling warnings with Turbopack.
let schedulerStarted = false
let serverInitDone   = false

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

async function serverInit() {
  if (serverInitDone) return
  serverInitDone = true

  // Startup: mark any orphaned 'running' Supabase records as failed
  const cleaned = await cleanupStaleRunningRecords()
  if (cleaned > 0) console.log(`[startup] Marked ${cleaned} stale running deployment(s) as failed`)

  // Log which notification channels are active so Railway logs confirm config
  console.log(`[startup] Notifications — Slack: ${isSlackConfigured()}, Pumble: ${isPumbleConfigured()}`)

  // Notify Slack of any pending schedules that existed before this process started
  const pending = await listSchedules()
  if (pending.length > 0) {
    console.log(`[startup] Notifying Slack of ${pending.length} pending schedule(s)`)
    await Promise.all(pending.map(s =>
      broadcastMessage(
        buildScheduledBlocks(s.source, s.destination, s.site_name ?? s.site, s.scheduled_for, s.notes, s.site),
        `Deployment scheduled: ${s.source} → ${s.destination} on ${s.site_name ?? s.site}`,
      )
    ))
  }

  // Shutdown: flush in-memory jobs to Supabase before the process exits
  const shutdown = async (signal: string) => {
    const active = getAllJobs().filter(j => ['running', 'awaiting-approval'].includes(j.status))
    if (active.length > 0) {
      console.log(`[${signal}] Finalizing ${active.length} in-flight job(s)...`)
      const shutdownEntry = {
        type: 'log' as const,
        logType: 'error' as const,
        message: `Server shutting down — deployment interrupted (${signal})`,
        ts: Date.now(),
      }
      await Promise.all(active.map(job =>
        finalizeDeploymentRecord(job.id, {
          stages_completed: job.completedStages,
          status: 'failed',
          completed_at: new Date().toISOString(),
          logs: [...job.logs, shutdownEntry],
        })
      ))
    }
    process.exit(0)
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT',  () => shutdown('SIGINT'))

  // Socket Mode is started at server boot via instrumentation.ts — no-op here
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
  await serverInit()
  const result = await runDueSchedules()
  return Response.json(result)
}

// GET — used by the dev server to auto-start on first page load
export async function GET() {
  startScheduler()
  await serverInit()
  return Response.json({ started: schedulerStarted })
}
