import { claimDueSchedules, claimPreNotifications } from '@/lib/supabase'
import { computeStages } from '@/lib/pipeline'
import { createJob } from '@/lib/jobStore'
import { executeJob } from '@/lib/deployer'
import { broadcastMessage, buildUpcomingBlocks } from '@/lib/slack'

export async function runDueSchedules(): Promise<{ triggered: number; skipped: number }> {
  // Send 10-minute pre-notifications for upcoming schedules
  const upcoming = await claimPreNotifications()
  for (const s of upcoming) {
    void broadcastMessage(
      buildUpcomingBlocks(s.source, s.destination, s.site_name ?? s.site, s.scheduled_for),
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
