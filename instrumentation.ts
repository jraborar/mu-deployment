export async function register() {
  // Edge runtime has no process signals or job store — skip
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  const { getAllJobs } = await import('@/lib/jobStore')
  const { finalizeDeploymentRecord, cleanupStaleRunningRecords } = await import('@/lib/supabase')

  // Startup: any 'running' record in Supabase is orphaned from the previous process
  const cleaned = await cleanupStaleRunningRecords()
  if (cleaned > 0) {
    console.log(`[startup] Marked ${cleaned} stale running deployment(s) as failed`)
  }

  // Shutdown: write in-memory job state to Supabase before the process exits
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

  process.on('SIGTERM', () => shutdown('SIGTERM')) // Railway graceful shutdown
  process.on('SIGINT',  () => shutdown('SIGINT'))  // local ctrl+c
}
