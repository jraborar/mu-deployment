import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import { processSingleton } from '@/lib/processSingleton'

export interface LogEntry {
  type: 'log'
  logType: 'info' | 'status' | 'warn' | 'delete' | 'deleted' | 'create' | 'success' | 'error'
  message: string
  ts: number
}

export interface Job {
  id: string
  site: string
  site_name?: string
  source: string
  destination: string
  stages: string[]
  completedStages: string[]
  currentStage: string | null
  // 'cancelled' is terminal and distinct from 'failed' — the history record has
  // always distinguished them; the in-memory job now does too, so a cancelled
  // job stops looking in-flight to /api/jobs and to the stale-job pruner.
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'awaiting-approval' | 'paused'
  autoApprove: boolean
  anchorAdvance: boolean   // advance sites.last_deployment on success (managed-cycle deploy only)
  cancelRequested: boolean
  // Set by the scheduler's stale-job pruner, which has already written the
  // 'failed' history record itself. It tells executeJob's catch block to unwind
  // quietly instead of finalizing a second time with a different status.
  prunedStale: boolean
  label: string
  logs: LogEntry[]
  startedAt: number
  // Last time this job emitted anything — the staleness clock. NOT startedAt:
  // a job can legitimately sit at an approval gate for hours and then do real
  // work, and killing it by age-since-creation cuts that work off mid-deploy.
  lastActivity: number
  emitter: EventEmitter
  pendingApproval: {
    resolve: (approved: boolean) => void
    approvalType: string
    message: string
    nextStage?: string
    diffStat?: string
    approveLabel?: string
    rejectLabel?: string
  } | null
}

const MAX_JOBS = 20

// One store for the whole process. It used to be a bare `new Map()`, which gave
// the instrumentation graph and the route handlers a Map each: a job created by
// the scheduler was then invisible to /api/jobs and unapprovable through
// /api/approve/[jobId]. See lib/processSingleton.ts for the full account.
const store = processSingleton('jobStore.store', () => new Map<string, Job>())

export function createJob(params: {
  site: string
  site_name?: string
  source: string
  destination: string
  stages: string[]
  autoApprove?: boolean
  anchorAdvance?: boolean
  label?: string
}): Job {
  if (store.size >= MAX_JOBS) {
    const oldest = [...store.entries()].sort((a, b) => a[1].startedAt - b[1].startedAt)[0]
    if (oldest) store.delete(oldest[0])
  }

  const job: Job = {
    id: randomUUID(),
    site: params.site,
    site_name: params.site_name,
    source: params.source,
    destination: params.destination,
    stages: params.stages,
    completedStages: [],
    currentStage: null,
    status: 'running',
    autoApprove: params.autoApprove ?? false,
    anchorAdvance: params.anchorAdvance ?? false,
    cancelRequested: false,
    prunedStale: false,
    label: params.label ?? params.source,
    logs: [],
    startedAt: Date.now(),
    lastActivity: Date.now(),
    emitter: new EventEmitter(),
    pendingApproval: null,
  }

  job.emitter.setMaxListeners(20)
  store.set(job.id, job)
  return job
}

/** Statuses a job never leaves. Kept in one place so a new terminal state can
 *  never again be added to the union without the routes that gate on it. */
export const TERMINAL_STATUSES: readonly Job['status'][] = ['completed', 'failed', 'cancelled', 'paused']

export function isTerminal(status: Job['status']): boolean {
  return TERMINAL_STATUSES.includes(status)
}

export function getJob(id: string): Job | undefined {
  return store.get(id)
}

export function getAllJobs(): Job[] {
  return [...store.values()]
}
