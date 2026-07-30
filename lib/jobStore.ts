import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'

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
  status: 'running' | 'completed' | 'failed' | 'awaiting-approval' | 'paused'
  autoApprove: boolean
  cancelRequested: boolean
  label: string
  logs: LogEntry[]
  startedAt: number
  lastActivity: number
  emitter: EventEmitter
  pendingApproval: {
    resolve: (approved: boolean) => void
    approvalType: string
    message: string
    nextStage?: string
    diffStat?: string
  } | null
}

const MAX_JOBS = 20
const store = new Map<string, Job>()

export function createJob(params: {
  site: string
  site_name?: string
  source: string
  destination: string
  stages: string[]
  autoApprove?: boolean
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
    cancelRequested: false,
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

export function getJob(id: string): Job | undefined {
  return store.get(id)
}

export function getAllJobs(): Job[] {
  return [...store.values()]
}
