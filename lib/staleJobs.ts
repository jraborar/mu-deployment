// The stale-job policy, kept in its own module with no runtime imports so
// `scripts/stale-job-check.ts` can exercise it under bare Node — the rest of the
// scheduler's graph pulls in Supabase, Slack and the `@/` path alias, none of
// which resolve outside Next's bundler.
import type { Job } from '@/lib/jobStore'

export const STALE_JOB_MS = 24 * 60 * 60 * 1000

/** Only the fields the policy reads, so tests can build fixtures cheaply. */
export type StaleCandidate = Pick<Job, 'status' | 'lastActivity'>

/**
 * A job is stale when it has been QUIET for `staleMs` — not when it was created
 * that long ago.
 *
 * The difference is not academic. Jobs park at approval gates with no activity
 * for as long as it takes a human to look, then resume real work. Ageing from
 * creation cut ApexOrderPickup's mu-260915 deploy off two minutes after it was
 * approved, 24h to the minute after it started, with two stages left to run.
 */
export function isStaleJob(job: StaleCandidate, now: number, staleMs: number = STALE_JOB_MS): boolean {
  if (!['running', 'awaiting-approval'].includes(job.status)) return false
  return now - job.lastActivity > staleMs
}

export function selectStaleJobs<T extends StaleCandidate>(jobs: T[], now: number, staleMs: number = STALE_JOB_MS): T[] {
  return jobs.filter(j => isStaleJob(j, now, staleMs))
}
