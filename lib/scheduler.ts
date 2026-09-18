import { claimDueSchedules, claimPreNotifications, finalizeDeploymentRecord } from '@/lib/supabase'
import { computeStages } from '@/lib/pipeline'
import { createJob, getAllJobs } from '@/lib/jobStore'
import { executeJob } from '@/lib/deployer'
import { broadcastMessage, buildUpcomingBlocks, buildScheduledBlocks } from '@/lib/slack'
import { getSite } from '@/lib/sites'
import { selectStaleJobs } from '@/lib/staleJobs'

/**
 * Fails jobs that have gone quiet for a full day.
 *
 * Staleness is measured from `lastActivity`, not `startedAt`. Measuring from
 * creation killed jobs that were doing real work: ApexOrderPickup's mu-260915
 * deploy sat at the test approval gate for ~23h58m, was approved, and was
 * pruned two minutes later — mid-snapshot, with two stages still to run.
 *
 * Pruning also has to actually STOP the job. Flipping `status` and emitting
 * 'done' only detaches the listeners; `executeJob` is a running async function
 * and carried straight on, deploying to test under a record that already said
 * "failed". Worse, it then parked at the live gate and blocked there forever,
 * invisible to /api/jobs (which lists only running/awaiting-approval). So this
 * uses the same abort handshake as the user-facing cancel route: set
 * `cancelRequested`, then resolve any pending approval so the loop unblocks and
 * unwinds through `checkCancelled`.
 */
async function pruneStaleJobs(): Promise<void> {
  const now = Date.now()
  const stale = selectStaleJobs(getAllJobs(), now)
  for (const job of stale) {
    const idleMin = Math.round((now - job.lastActivity) / 60000)
    job.status = 'failed'
    // Marks the record as already finalized here, so the catch block in
    // executeJob unwinds without overwriting it with 'cancelled' or 'paused'.
    job.prunedStale = true
    job.cancelRequested = true
    if (job.pendingApproval) {
      job.pendingApproval.resolve(false)
      job.pendingApproval = null
    }
    const entry = { type: 'log' as const, logType: 'error' as const, message: `Job automatically failed after ${idleMin} minutes with no activity`, ts: Date.now() }
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
    console.log(`[scheduler] Pruned stale job ${job.id} (${job.site} ${job.source} → ${job.destination}, idle ${idleMin} min, started ${new Date(job.startedAt).toISOString()})`)
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

    // Per-site approval policy from the shared registry: 'auto' runs through the
    // approval gates automatically; 'manual' pauses at the first gate for a human.
    const site = await getSite(schedule.site)
    const autoApprove = (site?.deploy_approval ?? 'manual') === 'auto'

    const job = createJob({
      site: schedule.site,
      site_name: schedule.site_name ?? undefined,
      source: schedule.source,
      destination: schedule.destination,
      stages,
      autoApprove,
      anchorAdvance: schedule.anchor_advance === true,
    })

    void executeJob(job)
    triggered++

    if (!autoApprove) {
      void broadcastMessage(
        buildScheduledBlocks(schedule.source, schedule.destination, schedule.site_name ?? schedule.site, schedule.scheduled_for, 'Awaiting your approval — open mu-deployment to approve.', schedule.site),
        `⏸ Manual approval required: ${schedule.source} → ${schedule.destination} on ${schedule.site_name ?? schedule.site} — approve in mu-deployment`,
      )
    }

    console.log(`[scheduler] ${autoApprove ? 'Auto-deploying' : 'Awaiting approval for'}: ${schedule.site} ${schedule.source} → ${schedule.destination} (job ${job.id})`)
  }

  return { triggered, skipped }
}
