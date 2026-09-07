import { runDueSchedules } from '@/lib/scheduler'
import { getAllJobs } from '@/lib/jobStore'
import { finalizeDeploymentRecord, cleanupStaleRunningRecords, listSchedules } from '@/lib/supabase'
import { broadcastMessage, buildScheduledBlocks, isSlackConfigured, isPumbleConfigured } from '@/lib/slack'
import { startSocketMode } from '@/lib/socketMode'

/**
 * Process-wide startup, extracted from app/api/cron/trigger/route.ts.
 *
 * It used to live in that route as module-scoped singletons, started on the
 * first request. The comment there said that avoided edge-runtime bundling
 * warnings — but the real answer to that is instrumentation.node.ts, which
 * instrumentation.ts already claimed existed and did not.
 *
 * The cost of starting lazily was that after every deploy the scheduler sat
 * dormant until something happened to hit /api/cron/trigger. In practice a
 * human opening the UI did it (app/page.tsx fetches that route on load), so it
 * self-healed most of the time and the gap went unnoticed. It was measured at
 * 3m32s after one redeploy — container up at 17:32:57, scheduler started at
 * 17:36:29 only because the endpoint was called by hand. A deployment due in
 * that window would simply not have fired, and the next tick is a minute later.
 *
 * The SIGTERM/SIGINT handlers had the same problem and it was worse: a
 * container that never served a request had no shutdown hook at all, so
 * in-flight jobs were never flushed to Supabase on redeploy.
 *
 * Both singleton flags stay, so calling this from boot AND from the route is
 * harmless — the route keeps its call as a fallback for the case where
 * instrumentation did not run (the same belt-and-braces the Socket Mode call
 * below already used).
 */

let schedulerStarted = false
let serverInitDone   = false

export function startScheduler(): void {
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
  // First tick is deliberately one interval away, not immediate: at boot the
  // process may still be finishing Terminus auth, and a due schedule will keep
  // for a minute. (mu-staging's equivalent fires with no delay, which is the
  // riskier choice.)
  setTimeout(tick, INTERVAL_MS)
  console.log('[scheduler] Started — checking for due deployments every minute')
}

export async function serverInit(): Promise<void> {
  if (serverInitDone) return
  serverInitDone = true

  // Startup: mark any orphaned 'running' Supabase records as failed.
  // Safe to run at boot here — STALE_GRACE_HOURS is 6, so a deployment that is
  // genuinely still going on Pantheon's side is never touched. (mu-staging's
  // equivalent uses a 5-MINUTE grace against runs whose p90 is 48 minutes,
  // which is why that one must NOT be moved to boot.)
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

  // Socket Mode: instrumentation starts it at boot, but call here as fallback
  // in case instrumentation didn't run (e.g. env vars not yet available at boot).
  // The singleton in lib/socketMode.ts ensures it only connects once.
  void startSocketMode()
}

/** Everything the process needs running, whoever asks first. Idempotent. */
export async function ensureStarted(): Promise<void> {
  startScheduler()
  await serverInit()
}

export function isSchedulerStarted(): boolean {
  return schedulerStarted
}
