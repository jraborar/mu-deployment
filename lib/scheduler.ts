import { claimDueSchedules, claimPreNotifications, finalizeDeploymentRecord } from '@/lib/supabase'
import { computeStages } from '@/lib/pipeline'
import { createJob, getAllJobs } from '@/lib/jobStore'
import { executeJob } from '@/lib/deployer'
import { broadcastMessage, buildUpcomingBlocks } from '@/lib/slack'

const STALE_JOB_MS = 24 * 60 * 60 * 1000

async function pruneStaleJobs(): Promise<void> {
  const now = Date.now()
  const stale = getAllJobs().filter(j =>
    ['running', 'awaiting-approval'].includes(j.status) &&
    now - j.startedAt > STALE_JOB_MS
  )
  for (const job of stale) {
    job.status = 'failed'
    const entry = { type: 'log' as const, logType: 'error' as const, message: 'Job automatically failed after 24 hours with no completion', ts: Date.now() }
    job.logs.push(entry)
    job.emitter.emit('event', entry)
    job.emitter.emit('event', { type: 'complete', status: 'failed' })
    job.emitter.emit('done')
    await finalizeDeploymentRecord(job.id, {
      stages_completed: job.completedStages,
      status: 'failed',
      completed_at: new Date().toISOString(),
      logs: job.logs,
      site_name: job.site_name,
    })
    console.log(`[scheduler] Pruned stale job ${job.id} (${job.site} ${job.source} → ${job.destination}, running since ${new Date(job.startedAt).toISOString()})`)
  }
}

export async function runDueSchedules(): Promise<{ triggered: number; skipped: number }> {
  await pruneStaleJobs()
  // Send 10-minute pre-notifications for upcoming schedules
  const upcoming = await claimPreNotifications()
  for (const s of upcoming) {
    void broadcastMessage(
      buildUpcomingBlocks(s.source, s.destination, s.site_name ?? s.site, s.scheduled_for, s.site),
      `⚡ Deployment starting in ~10 minutes: ${s.source} → ${s.destination} on ${s.site_name ?? s.site}`,
    )
  }

  // Atomic claim — each instance gets a disjoint set of rows even if both
  // check at the same millisecond.
  const due = await claimDueSchedules()
  if (!due.length) return { triggered: 0, skipped: 0 }

  let triggered = 0
  let skipped = 0

  for (const schedule of due) {
    const stages = computeStages(schedule.source, schedule.destination)
    if (stages.length === 0) {
      skipped++
      continue
    }

    const job = createJob({
      site: schedule.site,
      site_name: schedule.site_name ?? undefined,
      source: schedule.source,
      destination: schedule.destination,
      stages,
      autoApprove: true,
    })

    void executeJob(job)
    triggered++

    console.log(`[scheduler] Triggered deployment: ${schedule.site} ${schedule.source} → ${schedule.destination} (job ${job.id})`)
  }

  return { triggered, skipped }
}
