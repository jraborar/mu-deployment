import { runDueSchedules } from '@/lib/scheduler'
import { getAllJobs, getJob } from '@/lib/jobStore'
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
        buildScheduledBlocks(s.source, s.destination, s.site_name ?? s.site, s.scheduled_for, s.notes),
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

  // Slack Socket Mode
  const appToken  = process.env.SLACK_APP_TOKEN
  const botToken  = process.env.SLACK_BOT_TOKEN
  const channelId = process.env.SLACK_CHANNEL_ID
  if (!appToken || !botToken || !channelId) {
    const missing = ['SLACK_APP_TOKEN', 'SLACK_BOT_TOKEN', 'SLACK_CHANNEL_ID'].filter(k => !process.env[k])
    console.log(`[slack] Socket Mode skipped — missing env var(s): ${missing.join(', ')}`)
  } else {
    try {
      const { SocketModeClient } = await import('@slack/socket-mode')
      const socket = new SocketModeClient({ appToken, logLevel: 'warn' as never })

      socket.on('block_actions', async ({ event, ack }: { event: Record<string, unknown>; ack: () => Promise<void> }) => {
        await ack()
        const action = (event.actions as Array<{ value?: string }> | undefined)?.[0]
        if (!action?.value) return

        let parsed: { jobId?: string; approved?: boolean }
        try { parsed = JSON.parse(action.value) } catch { return }

        const { jobId, approved } = parsed
        if (!jobId) return

        const job = getJob(jobId)
        if (!job?.pendingApproval) {
          console.log(`[slack] Interaction for unknown or already-resolved job: ${jobId}`)
          return
        }
        job.pendingApproval.resolve(Boolean(approved))
        job.pendingApproval = null
        console.log(`[slack] Job ${jobId} ${approved ? 'approved' : 'rejected'} via Slack`)
      })

      await socket.start()
      console.log('[slack] Socket Mode client connected')
    } catch (err) {
      console.error('[slack] Failed to start Socket Mode client:', err)
    }
  }
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
