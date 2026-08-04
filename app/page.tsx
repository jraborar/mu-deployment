'use client'

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { computeStages, parseMuSourceDate, addBusinessDays, toDatetimeLocal } from '@/lib/pipeline'

// ── Types ──────────────────────────────────────────────────────────────────────

type DeployStatus = 'idle' | 'running' | 'awaiting-approval' | 'paused' | 'completed' | 'failed'
type ApprovalType = 'alignment' | 'stage'
type Tab = 'deploy' | 'schedule' | 'upcoming' | 'history'

interface LogEntry {
  type: 'log'
  logType: 'info' | 'status' | 'warn' | 'delete' | 'deleted' | 'create' | 'success' | 'error'
  message: string
  ts: number
}

interface ScheduleItem {
  id: string
  site: string
  site_name?: string
  source: string
  destination: string
  scheduled_for: string
  status: string
  notes?: string
  consultant?: string
}

interface RunningJobItem {
  id: string
  site: string
  site_name?: string
  source: string
  destination: string
  status: string
  stages: string[]
  completedStages: string[]
  currentStage: string | null
  startedAt: number
}

interface HistoryItem {
  id: string
  site: string
  site_name?: string
  source: string
  destination: string
  stages_completed: string[]
  status: string
  started_at: string
  completed_at: string | null
}

// ── Log styling ────────────────────────────────────────────────────────────────

const LOG_STYLES: Record<string, { prefix: string; cls: string }> = {
  info:    { prefix: '›',  cls: 'text-pantheon-text-muted' },
  status:  { prefix: '◈',  cls: 'text-pantheon-yellow' },
  warn:    { prefix: '⚠',  cls: 'text-pantheon-warning' },
  delete:  { prefix: '✕',  cls: 'text-pantheon-error' },
  deleted: { prefix: '✓',  cls: 'text-pantheon-success-dim' },
  create:  { prefix: '⊕',  cls: 'text-pantheon-info' },
  success: { prefix: '✦',  cls: 'text-pantheon-success font-bold' },
  error:   { prefix: '✗',  cls: 'text-pantheon-error' },
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function LogLine({ entry }: { entry: LogEntry }) {
  const style = LOG_STYLES[entry.logType] ?? LOG_STYLES.info
  return (
    <div className={`flex gap-2 font-mono text-xs leading-relaxed ${style.cls}`}>
      <span className="shrink-0 select-none">{style.prefix}</span>
      <span className="break-all">{entry.message}</span>
    </div>
  )
}

function PipelineBar({
  stages, completedStages, currentStage,
}: {
  stages: string[]
  completedStages: string[]
  currentStage: string | null
}) {
  if (stages.length === 0) return null
  return (
    <div className="flex items-start gap-0">
      {stages.map((stage, i) => {
        const done   = completedStages.includes(stage)
        const active = currentStage === stage
        return (
          <div key={stage} className="flex items-center">
            {i > 0 && (
              <div className={`mt-3.5 h-px w-10 ${done ? 'bg-pantheon-success' : 'bg-pantheon-border'}`} />
            )}
            <div className="flex flex-col items-center gap-1">
              <div className={[
                'flex h-7 w-7 items-center justify-center rounded-full border font-mono text-xs font-bold transition-all',
                done   ? 'border-pantheon-success bg-pantheon-success/10 text-pantheon-success' : '',
                active ? 'border-pantheon-yellow bg-pantheon-yellow/10 text-pantheon-yellow animate-pulse' : '',
                !done && !active ? 'border-pantheon-border bg-pantheon-bg-elevated text-pantheon-text-dim' : '',
              ].join(' ')}>
                {done ? '✓' : active ? '⊙' : '○'}
              </div>
              <span className={`font-mono text-xs ${done ? 'text-pantheon-success' : active ? 'text-pantheon-yellow' : 'text-pantheon-text-dim'}`}>
                {stage}
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function ApprovalPrompt({
  approvalType, message, diffStat, nextStage, onApprove, onReject,
}: {
  approvalType: ApprovalType | null
  message: string
  diffStat?: string
  nextStage?: string | null
  onApprove: () => void
  onReject: () => void
}) {
  const isAlignment = approvalType === 'alignment'
  return (
    <div className="animate-slide-up rounded-xl border border-pantheon-yellow/40 bg-pantheon-yellow/5 p-5">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-pantheon-yellow">{isAlignment ? '⚠' : '◈'}</span>
        <span className="font-mono text-sm font-semibold text-pantheon-yellow">
          {isAlignment ? 'Alignment Check' : `Ready to deploy to ${nextStage}`}
        </span>
      </div>
      <p className="mb-4 font-mono text-xs text-pantheon-text-muted">{message}</p>
      <div className="flex gap-3">
        <button
          onClick={onApprove}
          className="rounded-lg bg-pantheon-yellow px-4 py-2 font-mono text-xs font-semibold text-black hover:bg-pantheon-yellow-dark transition-colors"
        >
          {isAlignment ? '↙ Merge Dev First' : `✓ Deploy to ${nextStage}`}
        </button>
        <button
          onClick={onReject}
          className="rounded-lg border border-pantheon-border px-4 py-2 font-mono text-xs text-pantheon-text-muted hover:border-pantheon-border-hi hover:text-pantheon-text transition-colors"
        >
          {isAlignment ? 'Skip →' : '⏸ Pause Here'}
        </button>
      </div>
    </div>
  )
}

// Converts a stored UTC ISO string to a datetime-local value in Manila time (Asia/Manila / UTC+8)
// sv-SE locale reliably produces "YYYY-MM-DD HH:mm:ss" which we trim to "YYYY-MM-DDTHH:mm"
function toManilaDatetimeLocal(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleString('sv-SE', { timeZone: 'Asia/Manila' }).slice(0, 16).replace(' ', 'T')
}

const editInputCls = [
  'w-full rounded border border-pantheon-border bg-pantheon-bg',
  'px-2 py-1 font-mono text-xs text-pantheon-text placeholder-pantheon-text-dim',
  'outline-none transition focus:border-pantheon-yellow focus:ring-1 focus:ring-pantheon-yellow',
].join(' ')

function ScheduleTable({
  schedules, editingId, editFor, editNotes,
  onEdit, onSave, onCancelEdit, onRunNow, onCancel,
  setEditFor, setEditNotes,
}: {
  schedules: ScheduleItem[]
  editingId: string | null
  editFor: string
  editNotes: string
  onEdit: (item: ScheduleItem) => void
  onSave: (id: string) => void
  onCancelEdit: () => void
  onRunNow: (item: ScheduleItem) => void
  onCancel: (id: string) => void
  setEditFor: (v: string) => void
  setEditNotes: (v: string) => void
}) {
  const [confirmingId, setConfirmingId] = useState<string | null>(null)

  const fmtDt = (iso: string) =>
    new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Manila' })

  return (
    <div className="rounded-xl border border-pantheon-border bg-pantheon-bg-card overflow-hidden">
      <table className="w-full border-collapse">
        <thead>
          <tr className="bg-pantheon-bg-elevated">
            <th className="px-4 py-2.5 text-left font-mono text-xs uppercase tracking-widest text-pantheon-text-muted">Site</th>
            <th className="px-4 py-2.5 text-left font-mono text-xs uppercase tracking-widest text-pantheon-text-muted">Pipeline</th>
            <th className="px-4 py-2.5 text-left font-mono text-xs uppercase tracking-widest text-pantheon-text-muted">Scheduled For</th>
            <th className="px-4 py-2.5 text-left font-mono text-xs uppercase tracking-widest text-pantheon-text-muted">Notes</th>
            <th className="px-4 py-2.5 text-right font-mono text-xs uppercase tracking-widest text-pantheon-text-muted">Actions</th>
          </tr>
        </thead>
        <tbody>
          {schedules.map(item => {
            const isEditing    = editingId === item.id
            const isConfirming = confirmingId === item.id
            return (
              <tr key={item.id} className="border-t border-pantheon-border hover:bg-pantheon-bg-elevated/40 transition-colors">
                <td className="px-4 py-3 font-mono text-sm font-semibold text-pantheon-text whitespace-nowrap">
                  {item.site_name ?? item.site}
                </td>
                <td className="px-4 py-3 font-mono text-sm whitespace-nowrap">
                  <span className="text-pantheon-yellow">{item.source}</span>
                  <span className="mx-1.5 text-pantheon-text-dim">→</span>
                  <span className="text-pantheon-info">{item.destination}</span>
                </td>
                <td className="px-4 py-3 font-mono text-sm text-pantheon-text-muted">
                  {isEditing ? (
                    <input
                      type="datetime-local"
                      value={editFor}
                      onChange={e => setEditFor(e.target.value)}
                      className={editInputCls}
                    />
                  ) : (
                    fmtDt(item.scheduled_for)
                  )}
                </td>
                <td className="px-4 py-3 font-mono text-sm text-pantheon-text-dim max-w-[160px]">
                  {isEditing ? (
                    <input
                      type="text"
                      value={editNotes}
                      onChange={e => setEditNotes(e.target.value)}
                      placeholder="Notes"
                      className={editInputCls}
                    />
                  ) : (
                    <span className="truncate block">{item.notes ?? '—'}</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <div className="flex gap-1.5 justify-end items-center">
                    {isEditing ? (
                      <>
                        <button
                          onClick={() => onSave(item.id)}
                          disabled={!editFor}
                          className="rounded border border-pantheon-success/40 px-2.5 py-1 font-mono text-xs text-pantheon-success hover:bg-pantheon-success/10 disabled:opacity-40 transition-colors"
                        >
                          Save
                        </button>
                        <button
                          onClick={onCancelEdit}
                          className="rounded border border-pantheon-border px-2.5 py-1 font-mono text-xs text-pantheon-text-muted hover:bg-pantheon-bg-elevated transition-colors"
                        >
                          Cancel
                        </button>
                      </>
                    ) : isConfirming ? (
                      <>
                        <span className="font-mono text-xs text-pantheon-error mr-1">Delete?</span>
                        <button
                          onClick={() => { setConfirmingId(null); onCancel(item.id) }}
                          className="rounded border border-pantheon-error/40 px-2.5 py-1 font-mono text-xs text-pantheon-error hover:bg-pantheon-error/10 transition-colors"
                        >
                          Yes
                        </button>
                        <button
                          onClick={() => setConfirmingId(null)}
                          className="rounded border border-pantheon-border px-2.5 py-1 font-mono text-xs text-pantheon-text-muted hover:bg-pantheon-bg-elevated transition-colors"
                        >
                          No
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          onClick={() => onRunNow(item)}
                          title="Run Now"
                          className="rounded border border-pantheon-yellow/40 px-2.5 py-1 font-mono text-xs text-pantheon-yellow hover:bg-pantheon-yellow/10 transition-colors"
                        >
                          ▶
                        </button>
                        <button
                          onClick={() => onEdit(item)}
                          title="Edit"
                          className="rounded border border-pantheon-border px-2.5 py-1 font-mono text-xs text-pantheon-text-muted hover:border-pantheon-border-hi hover:text-pantheon-text transition-colors"
                        >
                          ✎
                        </button>
                        <button
                          onClick={() => setConfirmingId(item.id)}
                          title="Delete"
                          className="rounded border border-pantheon-error/40 px-2.5 py-1 font-mono text-xs text-pantheon-error hover:bg-pantheon-error/10 transition-colors"
                        >
                          ✕
                        </button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function HistoryCard({ item }: { item: HistoryItem }) {
  const statusColors: Record<string, string> = {
    completed: 'text-pantheon-success',
    failed:    'text-pantheon-error',
    paused:    'text-pantheon-warning',
    cancelled: 'text-pantheon-text-muted',
    running:   'text-pantheon-info animate-pulse',
  }
  const siteColor = statusColors[item.status] ?? 'text-pantheon-text-muted'
  const endLabel  = item.status === 'failed' ? 'Exited:' : 'Completed:'
  const fmt = (ts: string) =>
    new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })

  return (
    <div className="rounded-lg border border-pantheon-border bg-pantheon-bg-elevated p-4 space-y-1.5">
      <div className="flex items-center justify-between">
        <div className="truncate mr-4">
          {item.site_name ? (
            <span className={`font-mono text-sm font-semibold ${siteColor}`}>
              {item.site_name}
              <span className="ml-1.5 font-normal text-pantheon-text-dim text-xs">· {item.site}</span>
            </span>
          ) : (
            <span className={`font-mono text-sm font-semibold ${siteColor}`}>{item.site}</span>
          )}
        </div>
        <span className={`font-mono text-xs font-semibold shrink-0 ${siteColor}`}>
          {item.status}
        </span>
      </div>
      <div className="font-mono text-xs">
        <span className="text-pantheon-yellow">{item.source}</span>
        <span className="mx-1.5 text-pantheon-text-dim">→</span>
        <span className="text-pantheon-info">{item.destination}</span>
        {item.stages_completed.length > 0 && (
          <span className="ml-2 text-pantheon-text-dim">
            ({item.stages_completed.join(' → ')})
          </span>
        )}
      </div>
      <div className={`flex flex-wrap gap-x-4 font-mono text-xs ${siteColor}`}>
        <span>Started: {fmt(item.started_at)}</span>
        <span>{endLabel} {item.completed_at ? fmt(item.completed_at) : '—'}</span>
      </div>
    </div>
  )
}

function RunningJobCard({
  job, logs, siteName, onEvict,
}: {
  job: RunningJobItem
  logs: LogEntry[]
  siteName: string  // human-readable label (may equal site UUID if unresolved)
  onEvict?: () => void
}) {
  const logRef = useRef<HTMLDivElement>(null)
  const [confirming, setConfirming] = useState(false)
  const elapsedMin = Math.floor((Date.now() - job.startedAt) / 60000)

  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logs])

  return (
    <div className="rounded-xl border border-pantheon-border bg-pantheon-bg-card p-4 space-y-3 animate-fade-in">
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          {siteName !== job.site ? (
            <div className="font-mono text-sm font-semibold text-pantheon-info">
              {siteName}
              <span className="ml-1.5 font-normal text-pantheon-text-dim text-xs">· {job.site}</span>
            </div>
          ) : (
            <div className="font-mono text-sm font-semibold text-pantheon-info">{job.site}</div>
          )}
          <div className="font-mono text-xs">
            <span className="text-pantheon-yellow">{job.source}</span>
            <span className="mx-1.5 text-pantheon-text-dim">→</span>
            <span className="text-pantheon-info">{job.destination}</span>
          </div>
        </div>
        <div className="text-right space-y-0.5">
          <div className="font-mono text-xs text-pantheon-info animate-pulse">● running</div>
          <div className="font-mono text-xs text-pantheon-text-dim">{elapsedMin} min elapsed</div>
          {onEvict && (
            confirming ? (
              <div className="flex gap-1 justify-end items-center">
                <span className="font-mono text-xs text-pantheon-error">Force stop?</span>
                <button
                  onClick={() => { setConfirming(false); onEvict() }}
                  className="rounded border border-pantheon-error/40 px-2 py-0.5 font-mono text-xs text-pantheon-error hover:bg-pantheon-error/10 transition-colors"
                >Yes</button>
                <button
                  onClick={() => setConfirming(false)}
                  className="rounded border border-pantheon-border px-2 py-0.5 font-mono text-xs text-pantheon-text-muted hover:bg-pantheon-bg-elevated transition-colors"
                >No</button>
              </div>
            ) : (
              <button
                onClick={() => setConfirming(true)}
                className="font-mono text-xs text-pantheon-error/60 hover:text-pantheon-error transition-colors"
              >✕ Force Stop</button>
            )
          )}
        </div>
      </div>

      {/* Stage indicators */}
      {job.stages.length > 0 && (
        <div className="flex gap-2">
          {job.stages.map(stage => {
            const done   = job.completedStages.includes(stage)
            const active = job.currentStage === stage
            return (
              <div key={stage} className={[
                'flex items-center gap-1 rounded px-2 py-0.5 font-mono text-xs border',
                done   ? 'border-pantheon-success/40 text-pantheon-success' :
                active ? 'border-pantheon-yellow/40 text-pantheon-yellow' :
                         'border-pantheon-border text-pantheon-text-dim',
              ].join(' ')}>
                {done ? '✓' : active ? '⊙' : '○'} {stage}
              </div>
            )
          })}
        </div>
      )}

      {/* Live log */}
      <div
        ref={logRef}
        className="h-40 overflow-y-auto bg-pantheon-bg-console rounded p-3 space-y-0.5"
      >
        {logs.map((entry, i) => {
          const style = LOG_STYLES[entry.logType] ?? LOG_STYLES.info
          return (
            <div key={i} className={`font-mono text-xs ${style.cls}`}>
              <span className="opacity-50 mr-1.5">{style.prefix}</span>{entry.message}
            </div>
          )
        })}
        {logs.length === 0 && (
          <span className="font-mono text-xs text-pantheon-text-dim">Connecting...</span>
        )}
        <span className="inline-block h-3 w-1 bg-pantheon-yellow animate-blink" />
      </div>
    </div>
  )
}

// ── Input + Select shared styles ───────────────────────────────────────────────

const inputCls = [
  'w-full rounded-lg border border-pantheon-border bg-pantheon-bg-elevated',
  'px-3.5 py-2.5 font-mono text-sm text-pantheon-text placeholder-pantheon-text-dim',
  'outline-none transition focus:border-pantheon-yellow focus:ring-1 focus:ring-pantheon-yellow',
  'disabled:opacity-50',
].join(' ')

// ── Main page ──────────────────────────────────────────────────────────────────

export default function Page() {
  const [tab, setTab] = useState<Tab>('deploy')

  // Deploy state
  const [site, setSite]                = useState('')
  const [source, setSource]            = useState('')
  const [label, setLabel]              = useState('')
  const [destination, setDestination]  = useState<'dev' | 'test' | 'live'>('live')
  const [deployStatus, setDeployStatus] = useState<DeployStatus>('idle')
  const [jobId, setJobId]              = useState<string | null>(null)
  const [stages, setStages]            = useState<string[]>([])
  const [completedStages, setCompleted] = useState<string[]>([])
  const [currentStage, setCurrent]     = useState<string | null>(null)
  const [logs, setLogs]                = useState<LogEntry[]>([])
  const [approvalType, setApprovalType] = useState<ApprovalType | null>(null)
  const [approvalMsg, setApprovalMsg]  = useState('')
  const [diffStat, setDiffStat]        = useState<string | undefined>()
  const [nextStage, setNextStage]      = useState<string | null>(null)

  // Schedule state
  const [schedSites, setSchedSites]    = useState([{ site: '', source: '' }])
  const [schedDest, setSchedDest]      = useState<'dev' | 'test' | 'live'>('live')
  const [schedFor, setSchedFor]        = useState('')
  const [schedNotes, setSchedNotes]    = useState('')
  const [schedConsultant, setSchedConsultant] = useState('')
  const [schedLoading, setSchedLoading] = useState(false)
  const [schedules, setSchedules]      = useState<ScheduleItem[]>([])

  const [editingId, setEditingId]   = useState<string | null>(null)
  const [editFor, setEditFor]       = useState('')
  const [editNotes, setEditNotes]   = useState('')

  const [schedFetchedCreatedDate, setSchedFetchedCreatedDate] = useState<Date | null>(null)
  const [schedDateFetching, setSchedDateFetching]             = useState(false)
  const schedForEdited = useRef(false)

  // Creation date: parsed from first site's source name (fast) OR fetched from Terminus (fallback)
  const schedCreatedDate = useMemo(
    () => parseMuSourceDate(schedSites[0]?.source ?? '') ?? schedFetchedCreatedDate,
    [schedSites, schedFetchedCreatedDate],
  )
  const schedDefaultDate = useMemo(() => {
    if (!schedCreatedDate || isNaN(schedCreatedDate.getTime())) return null
    return addBusinessDays(schedCreatedDate, 3)
  }, [schedCreatedDate])

  // Returns the default datetime-local string for a given date: Manila date + 3PM
  const getManilaDefaultFor = (date: Date): string => {
    const dateStr = date.toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' })
    return `${dateStr}T15:00`
  }

  // When first site row changes: reset date and re-evaluate
  useEffect(() => {
    const site   = schedSites[0]?.site   ?? ''
    const source = schedSites[0]?.source ?? ''
    schedForEdited.current = false
    setSchedFetchedCreatedDate(null)
    setSchedFor('')

    // If name has an embedded date we already have what we need — no API call
    if (!source || parseMuSourceDate(source)) return
    // Need both site and source to fetch
    if (!site) return

    const timer = setTimeout(async () => {
      setSchedDateFetching(true)
      try {
        const res = await fetch(
          `/api/multidev-info?site=${encodeURIComponent(site)}&source=${encodeURIComponent(source)}`
        )
        if (res.ok) {
          const { created } = await res.json()
          if (created) {
            const d = new Date(created)
            if (!isNaN(d.getTime())) setSchedFetchedCreatedDate(d)
          }
        }
      } catch {}
      setSchedDateFetching(false)
    }, 600)

    return () => clearTimeout(timer)
  }, [schedSites])

  // Auto-populate the datetime input at 3PM Manila once a default date is known
  useEffect(() => {
    if (schedDefaultDate && !schedForEdited.current) {
      setSchedFor(getManilaDefaultFor(schedDefaultDate))
    }
  }, [schedDefaultDate])

  // History state
  const [history, setHistory] = useState<HistoryItem[]>([])

  // Running jobs (scheduled deployments with live SSE)
  const [runningJobs, setRunningJobs]   = useState<RunningJobItem[]>([])
  const [jobLogs, setJobLogs]           = useState<Record<string, LogEntry[]>>({})
  const [jobStages, setJobStages]       = useState<Record<string, Pick<RunningJobItem, 'stages' | 'completedStages' | 'currentStage' | 'status'>>>({})
  const sseConnections = useRef<Record<string, EventSource>>({})

  const [resetCountdown, setResetCountdown] = useState<number | null>(null)

  const consoleRef       = useRef<HTMLDivElement>(null)
  const abortRef         = useRef<AbortController | null>(null)
  const deployStatusRef  = useRef<DeployStatus>('idle')
  const jobIdRef         = useRef<string | null>(null)
  const isTerminal       = ['completed', 'failed', 'paused'].includes(deployStatus)

  // Keep refs in sync so async callbacks always see current values
  useEffect(() => { deployStatusRef.current = deployStatus }, [deployStatus])
  useEffect(() => { jobIdRef.current = jobId }, [jobId])

  // Auto-reset the deploy form 60s after completion or failure
  useEffect(() => {
    if (!['completed', 'failed'].includes(deployStatus)) {
      setResetCountdown(null)
      return
    }
    let count = 60
    setResetCountdown(count)
    const interval = setInterval(() => {
      count -= 1
      setResetCountdown(count)
      if (count <= 0) {
        clearInterval(interval)
        reset()
      }
    }, 1000)
    return () => clearInterval(interval)
  }, [deployStatus]) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-refresh history when a deployment finishes
  useEffect(() => {
    if (['completed', 'failed', 'cancelled', 'paused'].includes(deployStatus)) {
      fetch('/api/deployments').then(r => r.json()).then(setHistory).catch(() => {})
    }
  }, [deployStatus])

  // Auto-fill label from source when source is a custom multidev
  useEffect(() => {
    if (!['dev', 'test', 'live'].includes(source)) setLabel(source)
  }, [source])

  // Auto-scroll console
  useEffect(() => {
    const el = consoleRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logs])

  // Reconnect from sessionStorage + kick the scheduler singleton on mount
  useEffect(() => {
    const saved = sessionStorage.getItem('mu-deploy-job-id')
    if (saved) setJobId(saved)
    fetch('/api/cron/trigger').catch(() => {})
  }, [])

  // Fetch schedules and history when tabs open
  useEffect(() => {
    if (tab === 'schedule' || tab === 'upcoming') {
      fetch('/api/schedule').then(r => r.json()).then(setSchedules).catch(() => {})
    }
    if (tab === 'history') {
      fetch('/api/deployments').then(r => r.json()).then(setHistory).catch(() => {})
    }
  }, [tab])

  // Poll for running jobs when History tab is open
  useEffect(() => {
    if (tab !== 'history') {
      // Close all SSE connections when leaving History tab
      Object.values(sseConnections.current).forEach(es => es.close())
      sseConnections.current = {}
      setRunningJobs([])
      return
    }
    const poll = () =>
      fetch('/api/jobs').then(r => r.json()).then(setRunningJobs).catch(() => {})
    poll()
    const interval = setInterval(poll, 5000)
    return () => clearInterval(interval)
  }, [tab])

  // Manage SSE connections for each running job
  useEffect(() => {
    const connections = sseConnections.current
    const activeIds = new Set(runningJobs.map(j => j.id))

    // Open new connections for newly discovered jobs
    for (const job of runningJobs) {
      if (connections[job.id]) continue
      const es = new EventSource(`/api/deploy/${job.id}`)
      es.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data) as Record<string, unknown>
          if (data.type === 'log') {
            setJobLogs(prev => ({ ...prev, [job.id]: [...(prev[job.id] ?? []), data as unknown as LogEntry] }))
          }
          if (data.type === 'job-meta' || data.type === 'stage-start' || data.type === 'stage-complete') {
            setJobStages(prev => ({
              ...prev,
              [job.id]: {
                stages:          (data.stages as string[]) ?? prev[job.id]?.stages ?? [],
                completedStages: (data.completedStages as string[]) ?? prev[job.id]?.completedStages ?? [],
                currentStage:    (data.currentStage as string | null) ?? prev[job.id]?.currentStage ?? null,
                status:          (data.status as string) ?? prev[job.id]?.status ?? 'running',
              },
            }))
          }
          if (data.type === 'complete') {
            es.close()
            delete connections[job.id]
            setRunningJobs(prev => prev.filter(j => j.id !== job.id))
            fetch('/api/deployments').then(r => r.json()).then(setHistory).catch(() => {})
          }
        } catch {}
      }
      connections[job.id] = es
    }

    // Close connections for jobs no longer in the list
    for (const id of Object.keys(connections)) {
      if (!activeIds.has(id)) {
        connections[id].close()
        delete connections[id]
      }
    }
  }, [runningJobs])


  const handleSSEData = useCallback((data: Record<string, unknown>) => {
    switch (data.type) {
      case 'job-meta':
        // Restores pipeline visualization state on reconnect
        setSite(data.site as string)
        setSource(data.source as string)
        setDestination(data.destination as 'dev' | 'test' | 'live')
        setStages(data.stages as string[])
        setCompleted(data.completedStages as string[])
        setCurrent(data.currentStage as string | null)
        if (['running', 'awaiting-approval'].includes(data.status as string)) {
          setDeployStatus(data.status as DeployStatus)
        }
        break
      case 'log':
        setLogs(prev => [...prev, data as unknown as LogEntry])
        break
      case 'stage-start':
        setCurrent(data.stage as string)
        break
      case 'stage-complete':
        setCompleted(prev => [...prev, data.stage as string])
        setCurrent(null)
        break
      case 'awaiting-approval':
        setDeployStatus('awaiting-approval')
        setApprovalType(data.approvalType as ApprovalType)
        setApprovalMsg(data.message as string)
        setNextStage((data.nextStage as string) ?? null)
        setDiffStat(data.diffStat as string | undefined)
        break
      case 'complete':
        setDeployStatus(
          data.status === 'completed' ? 'completed'
          : data.status === 'paused'  ? 'paused'
          : 'failed'
        )
        sessionStorage.removeItem('mu-deploy-job-id')
        break
    }
  }, [])

  const readSSEStream = useCallback(async (response: Response) => {
    const reader  = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer    = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop()!
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          try { handleSSEData(JSON.parse(line.slice(6))) } catch {}
        }
      }
    } catch (err) {
      // AbortError is expected when reset() or a new deployment cancels the stream
      if ((err as Error).name !== 'AbortError') {
        setDeployStatus('failed')
      }
    } finally {
      reader.cancel()
    }
  }, [handleSSEData])

  // Streams a response and auto-reconnects if the connection drops while the
  // job is still running. Handles Railway proxy timeouts transparently.
  const streamWithAutoReconnect = useCallback(async (initialResponse: Response, id: string) => {
    let response = initialResponse
    let attempts = 0
    const MAX = 8

    while (attempts <= MAX) {
      await readSSEStream(response)

      const status = deployStatusRef.current
      if (!['running', 'awaiting-approval'].includes(status)) break
      if (abortRef.current?.signal.aborted) break

      // Stream dropped mid-job — wait then reconnect
      attempts++
      const delay = Math.min(1000 * 2 ** attempts, 30_000)
      await new Promise(r => setTimeout(r, delay))
      if (abortRef.current?.signal.aborted) break

      try {
        response = await fetch(`/api/deploy/${id}`, { signal: abortRef.current?.signal })
        if (!response.ok) break
      } catch { break }
    }
  }, [readSSEStream])

  const startDeployment = async () => {
    abortRef.current?.abort()
    abortRef.current = new AbortController()

    setLogs([])
    setCompleted([])
    setCurrent(null)
    setNextStage(null)
    setApprovalType(null)
    setApprovalMsg('')
    setDiffStat(undefined)
    setDeployStatus('running')
    setStages(computeStages(source, destination))

    try {
      const res = await fetch('/api/deploy', {
        method: 'POST',
        signal: abortRef.current.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ site, source, destination, label: label || source }),
      })

      if (!res.ok) {
        const err = await res.json()
        setDeployStatus('failed')
        setLogs([{ type: 'log', logType: 'error', message: err.error ?? 'Failed to start deployment', ts: Date.now() }])
        return
      }

      const id = res.headers.get('X-Job-Id') ?? ''
      if (id) {
        setJobId(id)
        sessionStorage.setItem('mu-deploy-job-id', id)
      }

      await streamWithAutoReconnect(res, id)
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setDeployStatus('failed')
      }
    }
  }

  const reconnect = async () => {
    if (!jobId) return
    abortRef.current?.abort()
    abortRef.current = new AbortController()
    setDeployStatus('running')
    try {
      const res = await fetch(`/api/deploy/${jobId}`, { signal: abortRef.current.signal })
      if (!res.ok) {
        reset()
        return
      }
      await streamWithAutoReconnect(res, jobId)
    } catch (err) {
      if ((err as Error).name !== 'AbortError') reset()
    }
  }

  const sendApproval = async (approved: boolean) => {
    if (!jobId) return
    setDeployStatus('running')
    setApprovalType(null)
    await fetch(`/api/approve/${jobId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved }),
    })
  }

  const evictJob = async (id: string) => {
    await fetch(`/api/deploy/${id}/evict`, { method: 'POST' })
    setRunningJobs(prev => prev.filter(j => j.id !== id))
    fetch('/api/deployments').then(r => r.json()).then(setHistory).catch(() => {})
  }

  const cancelDeployment = async () => {
    if (!jobId) return
    await fetch(`/api/deploy/${jobId}/cancel`, { method: 'POST' })
  }

  const reset = () => {
    abortRef.current?.abort()
    abortRef.current = null
    setDeployStatus('idle')
    setLogs([])
    setCompleted([])
    setCurrent(null)
    setStages([])
    setNextStage(null)
    setApprovalType(null)
    setJobId(null)
    sessionStorage.removeItem('mu-deploy-job-id')
  }

  const cancelSchedule = async (id: string) => {
    await fetch('/api/schedule', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    setSchedules(prev => prev.filter(s => s.id !== id))
  }

  const saveEdit = async (id: string) => {
    await fetch('/api/schedule', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, scheduled_for: new Date(editFor + ':00+08:00').toISOString(), notes: editNotes }),
    })
    setEditingId(null)
    const updated = await fetch('/api/schedule').then(r => r.json())
    setSchedules(updated)
  }

  const runScheduleNow = (item: ScheduleItem) => {
    setSite(item.site)
    setSource(item.source)
    setDestination(item.destination as 'dev' | 'test' | 'live')
    setTab('deploy')
  }

  const submitSchedule = async () => {
    const validSites = schedSites.filter(s => s.site && s.source)
    if (!validSites.length || !schedFor) return
    setSchedLoading(true)
    const scheduled_for = new Date(schedFor + ':00+08:00').toISOString()
    await Promise.all(validSites.map(({ site, source }) =>
      fetch('/api/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ site, source, destination: schedDest, scheduled_for, notes: schedNotes, consultant: schedConsultant }),
      })
    ))
    setSchedSites([{ site: '', source: '' }]); setSchedFor(''); setSchedNotes(''); setSchedConsultant('')
    const updated = await fetch('/api/schedule').then(r => r.json())
    setSchedules(updated)
    setSchedLoading(false)
    setTab('upcoming')
  }

  const TABS: { key: Tab; label: string }[] = [
    { key: 'deploy',   label: 'Deploy' },
    { key: 'schedule', label: 'Schedule' },
    { key: 'upcoming', label: 'Upcoming' },
    { key: 'history',  label: 'History' },
  ]

  const DEST_OPTS = ['dev', 'test', 'live'] as const

  return (
    <div className="space-y-8 animate-fade-in">
      {/* Page title */}
      <div>
        <h1 className="font-mono text-2xl font-bold text-pantheon-text">Deployment Console</h1>
        <p className="mt-1 font-mono text-sm text-pantheon-text-muted">
          Deploy Pantheon multidevs through the pipeline with per-stage approval gates
        </p>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-pantheon-border">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={[
              'px-4 py-2 font-mono text-sm transition-colors',
              tab === t.key
                ? 'border-b-2 border-pantheon-yellow text-pantheon-yellow'
                : 'text-pantheon-text-muted hover:text-pantheon-text',
            ].join(' ')}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Deploy tab ──────────────────────────────────────────────────────── */}
      {tab === 'deploy' && (
        <div className="space-y-6">

          {/* Reconnect banner */}
          {jobId && deployStatus === 'idle' && (
            <div className="flex items-center justify-between rounded-xl border border-pantheon-yellow/40 bg-pantheon-yellow/5 px-5 py-4">
              <span className="font-mono text-sm text-pantheon-yellow">
                A deployment session was found. Reconnect to see live output?
              </span>
              <div className="flex gap-2">
                <button onClick={reconnect} className="rounded-lg bg-pantheon-yellow px-4 py-1.5 font-mono text-xs font-semibold text-black hover:bg-pantheon-yellow-dark">
                  Reconnect
                </button>
                <button onClick={reset} className="rounded-lg border border-pantheon-border px-4 py-1.5 font-mono text-xs text-pantheon-text-muted hover:border-pantheon-border-hi">
                  Dismiss
                </button>
              </div>
            </div>
          )}

          {/* Config form */}
          {(deployStatus === 'idle' || deployStatus === 'paused') && (
            <div className="rounded-xl border border-pantheon-border bg-pantheon-bg-card p-6 space-y-5">
              {deployStatus === 'paused' && (
                <div className="rounded-lg border border-pantheon-warning/40 bg-pantheon-warning/5 px-4 py-3 font-mono text-xs text-pantheon-warning">
                  ⏸ Previous deployment paused after {completedStages[completedStages.length - 1] ?? 'start'}.
                  Set source to continue from where it left off.
                </div>
              )}
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label className="font-mono text-xs text-pantheon-text-muted">Site ID</label>
                  <input
                    className={inputCls}
                    placeholder="my-pantheon-site"
                    value={site}
                    onChange={e => setSite(e.target.value)}
                    disabled={deployStatus !== 'idle'}
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="font-mono text-xs text-pantheon-text-muted">
                    Source <span className="text-pantheon-text-dim">(multidev, dev, test or live)</span>
                  </label>
                  <input
                    className={inputCls}
                    placeholder="my-feature or dev"
                    value={source}
                    onChange={e => setSource(e.target.value)}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <label className="font-mono text-xs text-pantheon-text-muted">
                  Commit label <span className="text-pantheon-text-dim">(used in "Pantheon Managed Updates: Deployed from …")</span>
                </label>
                <input
                  className={inputCls}
                  placeholder="original multidev name e.g. autopilot"
                  value={label}
                  onChange={e => setLabel(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <label className="font-mono text-xs text-pantheon-text-muted">Final Destination</label>
                <div className="flex gap-2">
                  {DEST_OPTS.map(d => (
                    <button
                      key={d}
                      onClick={() => setDestination(d)}
                      className={[
                        'rounded-lg border px-4 py-2 font-mono text-sm transition-colors',
                        destination === d
                          ? 'border-pantheon-yellow bg-pantheon-yellow/10 text-pantheon-yellow'
                          : 'border-pantheon-border text-pantheon-text-muted hover:border-pantheon-border-hi',
                      ].join(' ')}
                    >
                      {d}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex items-center justify-between pt-1">
                <p className="font-mono text-xs text-pantheon-text-dim">
                  Pipeline: {computeStages(source, destination).join(' → ') || '—'}
                </p>
                <button
                  onClick={startDeployment}
                  disabled={!site || !source}
                  className="rounded-lg bg-pantheon-yellow px-5 py-2.5 font-mono text-sm font-semibold text-black hover:bg-pantheon-yellow-dark disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  ▶ Start Deployment
                </button>
              </div>
            </div>
          )}

          {/* Pipeline bar */}
          {stages.length > 0 && (
            <div className="rounded-xl border border-pantheon-border bg-pantheon-bg-card px-6 py-5">
              <div className="mb-4 flex items-center justify-between">
                <span className="font-mono text-xs font-semibold uppercase tracking-widest text-pantheon-text-muted">
                  Pipeline
                </span>
                <div className="flex gap-2">
                  {!isTerminal && deployStatus !== 'idle' && (
                    <button
                      onClick={cancelDeployment}
                      className="rounded border border-pantheon-error/50 px-3 py-1 font-mono text-xs text-pantheon-error hover:bg-pantheon-error/10 transition-colors"
                    >
                      ✕ Stop
                    </button>
                  )}
                  {isTerminal && (
                    <button
                      onClick={reset}
                      className="rounded border border-pantheon-border px-3 py-1 font-mono text-xs text-pantheon-text-muted hover:border-pantheon-border-hi transition-colors"
                    >
                      New Deployment
                    </button>
                  )}
                </div>
              </div>
              <PipelineBar stages={stages} completedStages={completedStages} currentStage={currentStage} />
            </div>
          )}

          {/* Approval prompt */}
          {deployStatus === 'awaiting-approval' && approvalType && (
            <ApprovalPrompt
              approvalType={approvalType}
              message={approvalMsg}
              diffStat={diffStat}
              nextStage={nextStage}
              onApprove={() => sendApproval(true)}
              onReject={() => sendApproval(false)}
            />
          )}

          {/* Status banners */}
          {deployStatus === 'completed' && (
            <div className="rounded-xl border border-pantheon-success/40 bg-pantheon-success/5 px-5 py-4">
              <p className="font-mono text-sm font-semibold text-pantheon-success">
                ✦ Deployment complete — {source} → {destination} on {site}
              </p>
            </div>
          )}
          {deployStatus === 'failed' && (
            <div className="rounded-xl border border-pantheon-error/40 bg-pantheon-error/5 px-5 py-4">
              <p className="font-mono text-sm font-semibold text-pantheon-error">
                ✗ Deployment failed — see the console below
              </p>
            </div>
          )}

          {/* Log console */}
          {logs.length > 0 && (
            <div className="rounded-xl border border-pantheon-border overflow-hidden">
              <div className="flex items-center gap-2 border-b border-pantheon-border bg-pantheon-bg-card px-4 py-2.5">
                <div className="flex gap-1.5">
                  <div className="h-3 w-3 rounded-full bg-pantheon-error/70" />
                  <div className="h-3 w-3 rounded-full bg-pantheon-warning/70" />
                  <div className="h-3 w-3 rounded-full bg-pantheon-success/70" />
                </div>
                <span className="font-mono text-xs text-pantheon-text-muted">console output</span>
                <div className="ml-auto flex items-center gap-1.5">
                  {deployStatus === 'running' && (
                    <>
                      <div className="h-1.5 w-1.5 rounded-full bg-pantheon-success animate-pulse" />
                      <span className="font-mono text-xs text-pantheon-success">live</span>
                    </>
                  )}
                  {isTerminal && (
                    <span className={`font-mono text-xs ${deployStatus === 'completed' ? 'text-pantheon-success' : deployStatus === 'paused' ? 'text-pantheon-warning' : 'text-pantheon-error'}`}>
                      {deployStatus}
                    </span>
                  )}
                </div>
              </div>
              <div
                ref={consoleRef}
                className="console-output h-72 overflow-y-auto bg-pantheon-bg-console p-4 space-y-0.5"
              >
                {logs.map((entry, i) => <LogLine key={i} entry={entry} />)}
                {deployStatus === 'running' && (
                  <span className="inline-block h-3.5 w-1.5 bg-pantheon-yellow animate-blink" />
                )}
              </div>
              {resetCountdown !== null && (
                <div className="flex items-center justify-between px-1 pt-1">
                  <span className="font-mono text-xs text-pantheon-text-dim">
                    Form resets in <span className="text-pantheon-text-muted">{resetCountdown}s</span>
                  </span>
                  <button
                    onClick={reset}
                    className="font-mono text-xs text-pantheon-yellow hover:underline"
                  >
                    Reset now
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Schedule tab ────────────────────────────────────────────────────── */}
      {tab === 'schedule' && (
        <div className="space-y-6">
          <div className="rounded-xl border border-pantheon-border bg-pantheon-bg-card p-6 space-y-5">
            <h2 className="font-mono text-sm font-semibold text-pantheon-text">Schedule a Deployment</h2>

            {/* Dynamic site rows */}
            <div className="space-y-2">
              <div className="grid grid-cols-[1fr_1fr_auto] gap-2 items-center">
                <span className="font-mono text-xs text-pantheon-text-muted">Site ID</span>
                <span className="font-mono text-xs text-pantheon-text-muted">Source</span>
                <span />
              </div>
              {schedSites.map((row, i) => {
                const isDuplicate = row.site && schedules.some(s => s.site === row.site)
                return (
                  <div key={i} className="space-y-1">
                    <div className="grid grid-cols-[1fr_1fr_auto] gap-2 items-center">
                      <input
                        className={inputCls}
                        placeholder="my-pantheon-site"
                        value={row.site}
                        onChange={e => setSchedSites(prev => prev.map((s, idx) => idx === i ? { ...s, site: e.target.value } : s))}
                      />
                      <input
                        className={inputCls}
                        placeholder="autopilot or dev"
                        value={row.source}
                        onChange={e => setSchedSites(prev => prev.map((s, idx) => idx === i ? { ...s, source: e.target.value } : s))}
                      />
                      <button
                        onClick={() => setSchedSites(prev => prev.length > 1 ? prev.filter((_, idx) => idx !== i) : prev)}
                        disabled={schedSites.length === 1}
                        className="rounded border border-pantheon-border px-2 py-2 font-mono text-xs text-pantheon-text-muted hover:border-pantheon-error/40 hover:text-pantheon-error disabled:opacity-30 transition-colors"
                      >✕</button>
                    </div>
                    {isDuplicate && (
                      <p className="font-mono text-xs text-pantheon-warning pl-1">
                        ⚠ {row.site} already has a pending schedule — you can still proceed or defer the existing one.
                      </p>
                    )}
                  </div>
                )
              })}
              <button
                onClick={() => setSchedSites(prev => [...prev, { site: '', source: '' }])}
                className="font-mono text-xs text-pantheon-info hover:text-pantheon-text transition-colors"
              >
                + Add another site
              </button>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label className="font-mono text-xs text-pantheon-text-muted">Final Destination</label>
                <div className="flex gap-2">
                  {DEST_OPTS.map(d => (
                    <button
                      key={d}
                      onClick={() => setSchedDest(d)}
                      className={[
                        'rounded-lg border px-4 py-2 font-mono text-sm transition-colors',
                        schedDest === d
                          ? 'border-pantheon-yellow bg-pantheon-yellow/10 text-pantheon-yellow'
                          : 'border-pantheon-border text-pantheon-text-muted hover:border-pantheon-border-hi',
                      ].join(' ')}
                    >
                      {d}
                    </button>
                  ))}
                </div>
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <label className="font-mono text-xs text-pantheon-text-muted">
                    Deployment Date
                  </label>
                  {schedDateFetching && (
                    <span className="font-mono text-xs text-pantheon-text-dim animate-pulse">
                      looking up creation date...
                    </span>
                  )}
                  {schedDefaultDate && schedCreatedDate && !schedDateFetching && (
                    <span className="font-mono text-xs text-pantheon-text-dim">
                      · default{' '}
                      <span className="text-pantheon-info">
                        {schedDefaultDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                      </span>
                      {' '}(3 business days from{' '}
                      <span className="text-pantheon-yellow">
                        {schedCreatedDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                      </span>
                      )
                    </span>
                  )}
                </div>
                <input
                  type="datetime-local"
                  className={inputCls}
                  value={schedFor}
                  onChange={e => {
                    schedForEdited.current = true
                    setSchedFor(e.target.value)
                  }}
                />
                {schedDefaultDate && schedCreatedDate && schedFor !== getManilaDefaultFor(schedDefaultDate) && schedFor && (
                  <p className="font-mono text-xs text-pantheon-warning">
                    ⚠ Overriding default — original: {schedDefaultDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                  </p>
                )}
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label className="font-mono text-xs text-pantheon-text-muted">MU Consultant</label>
                <input className={inputCls} placeholder="e.g. Jasper" value={schedConsultant} onChange={e => setSchedConsultant(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <label className="font-mono text-xs text-pantheon-text-muted">Notes (optional)</label>
                <input className={inputCls} placeholder="e.g. Sprint 12 release" value={schedNotes} onChange={e => setSchedNotes(e.target.value)} />
              </div>
            </div>
            <div className="flex items-center justify-between pt-1">
              <p className="font-mono text-xs text-pantheon-text-dim">
                Locally: auto-triggered every minute. Production: schedule a <span className="text-pantheon-yellow">POST /api/cron/trigger</span> call from any cron service.
              </p>
              <button
                onClick={submitSchedule}
                disabled={!schedSites.some(s => s.site && s.source) || !schedFor || schedLoading}
                className="rounded-lg bg-pantheon-yellow px-5 py-2.5 font-mono text-sm font-semibold text-black hover:bg-pantheon-yellow-dark disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {schedLoading ? 'Saving...' : '+ Schedule'}
              </button>
            </div>
          </div>

        </div>
      )}

      {/* ── Upcoming tab ─────────────────────────────────────────────────────── */}
      {tab === 'upcoming' && (
        <div className="space-y-4">
          {schedules.length > 0 ? (
            <ScheduleTable
              schedules={schedules}
              editingId={editingId}
              editFor={editFor}
              editNotes={editNotes}
              onEdit={(item) => {
                setEditingId(item.id)
                setEditFor(toManilaDatetimeLocal(item.scheduled_for))
                setEditNotes(item.notes ?? '')
              }}
              onSave={saveEdit}
              onCancelEdit={() => setEditingId(null)}
              onRunNow={runScheduleNow}
              onCancel={cancelSchedule}
              setEditFor={setEditFor}
              setEditNotes={setEditNotes}
            />
          ) : (
            <p className="font-mono text-sm text-pantheon-text-dim text-center py-8">
              No upcoming deployments —{' '}
              <button onClick={() => setTab('schedule')} className="text-pantheon-yellow hover:underline">
                schedule one
              </button>
            </p>
          )}
        </div>
      )}

      {/* ── History tab ─────────────────────────────────────────────────────── */}
      {tab === 'history' && (() => {
        const inMemoryIds    = new Set(runningJobs.map(j => j.id))
        // Supabase records marked running but not tracked in this server's memory
        const orphanedRunning = history.filter(item => item.status === 'running' && !inMemoryIds.has(item.id))
        const pastHistory     = history.filter(item => item.status !== 'running')
        const hasLive         = runningJobs.length > 0 || orphanedRunning.length > 0
        return (
          <div className="space-y-6">
            {/* Live — in-memory jobs + orphaned Supabase running records */}
            {hasLive && (
              <div className="space-y-3">
                <h2 className="font-mono text-xs font-semibold uppercase tracking-widest text-pantheon-yellow">
                  ● Live
                </h2>
                {runningJobs.map(job => {
                  const liveStages = jobStages[job.id]
                  const siteName = job.site_name ?? schedules.find(s => s.site === job.site)?.site_name ?? job.site
                  return (
                    <RunningJobCard
                      key={job.id}
                      job={liveStages ? { ...job, ...liveStages } : job}
                      logs={jobLogs[job.id] ?? []}
                      siteName={siteName}
                      onEvict={() => evictJob(job.id)}
                    />
                  )
                })}
                {orphanedRunning.map(item => <HistoryCard key={item.id} item={item} />)}
              </div>
            )}

            {/* Past */}
            <div className="space-y-3">
              {hasLive && pastHistory.length > 0 && (
                <h2 className="font-mono text-xs font-semibold uppercase tracking-widest text-pantheon-text-muted">
                  Past
                </h2>
              )}
              {!hasLive && pastHistory.length === 0 && (
                <p className="font-mono text-sm text-pantheon-text-dim text-center py-8">
                  No deployment history
                  {!process.env.NEXT_PUBLIC_SUPABASE_URL && ' — configure Supabase to enable history'}
                </p>
              )}
              {pastHistory.map(item => <HistoryCard key={item.id} item={item} />)}
            </div>
          </div>
        )
      })()}
    </div>
  )
}
