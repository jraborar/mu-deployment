import { getDueSchedules, markScheduleTriggered } from '@/lib/supabase'
import { computeStages } from '@/lib/pipeline'
import { createJob } from '@/lib/jobStore'
import { executeJob } from '@/lib/deployer'

export async function runDueSchedules(): Promise<{ triggered: number; skipped: number }> {
  const due = await getDueSchedules()
  if (!due.length) return { triggered: 0, skipped: 0 }

  let triggered = 0
  let skipped = 0

  for (const schedule of due) {
    const stages = computeStages(schedule.source, schedule.destination)
    if (stages.length === 0) {
      skipped++
      continue
    }

    // Mark triggered before starting — prevents double-firing on slow runs
    await markScheduleTriggered(schedule.id)

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
