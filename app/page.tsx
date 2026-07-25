'use client'

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { computeStages, parseMuSourceDate, addBusinessDays, toDatetimeLocal } from '@/lib/pipeline'

// ── Types ──────────────────────────────────────────────────────────────────────

type DeployStatus = 'idle' | 'running' | 'awaiting-approval' | 'paused' | 'completed' | 'failed'
type ApprovalType = 'alignment' | 'stage'
type Tab = 'deploy' | 'schedule' | 'history'

interface LogEntry {
  type: 'log'
  logType: 'info' | 'status' | 'warn' | 'delete' | 'deleted' | 'create' | 'success' | 'error'
  message: string
  ts: number
}

interface ScheduleItem {
  id: string
  site: string
  source: string
  destination: string
  scheduled_for: string
  status: string
  notes?: string
}

interface HistoryItem {
  id: string
  site: string
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

function ScheduleCard({
  item, onCancel, onRunNow,
}: {
  item: ScheduleItem
  onCancel: (id: string) => void
  onRunNow: (item: ScheduleItem) => void
}) {
  const dt = new Date(item.scheduled_for)
  return (
    <div className="flex items-center justify-between rounded-lg border border-pantheon-border bg-pantheon-bg-elevated p-4">
      <div className="space-y-0.5">
        <div className="font-mono text-sm font-semibold text-pantheon-text">
          {item.site}
          <span className="mx-2 text-pantheon-text-dim">·</span>
          <span className="text-pantheon-yellow">{item.source}</span>
          <span className="mx-2 text-pantheon-text-dim">→</span>
          <span className="text-pantheon-info">{item.destination}</span>
        </div>
        <div className="font-mono text-xs text-pantheon-text-muted">
          {dt.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}
        </div>
        {item.notes && (
          <div className="font-mono text-xs text-pantheon-text-dim">{item.notes}</div>
        )}
      </div>
      <div className="flex gap-2">
        <button
          onClick={() => onRunNow(item)}
          className="rounded border border-pantheon-yellow/40 px-3 py-1.5 font-mono text-xs text-pantheon-yellow hover:bg-pantheon-yellow/10 transition-colors"
        >
          ▶ Run Now
        </button>
        <button
          onClick={() => onCancel(item.id)}
          className="rounded border border-pantheon-error/40 px-3 py-1.5 font-mono text-xs text-pantheon-error hover:bg-pantheon-error/10 transition-colors"
        >
          Cancel
        </button>
      </div>
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
  const fmt = (ts: string) =>
    new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })

  return (
    <div className="rounded-lg border border-pantheon-border bg-pantheon-bg-elevated p-4 space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="font-mono text-sm font-semibold text-pantheon-text truncate mr-4">
          {item.site}
        </span>
        <span className={`font-mono text-xs font-semibold shrink-0 ${statusColors[item.status] ?? 'text-pantheon-text-muted'}`}>
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
      <div className="flex flex-wrap gap-x-4 font-mono text-xs text-pantheon-text-dim">
        <span><span className="text-pantheon-text-muted">Started:</span> {fmt(item.started_at)}</span>
        <span><span className="text-pantheon-text-muted">Completed:</span> {item.completed_at ? fmt(item.completed_at) : '—'}</span>
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
  const [schedSite, setSchedSite]      = useState('')
  const [schedSource, setSchedSource]  = useState('')
  const [schedDest, setSchedDest]      = useState<'dev' | 'test' | 'live'>('live')
  const [schedFor, setSchedFor]        = useState('')
  const [schedNotes, setSchedNotes]    = useState('')
  const [schedLoading, setSchedLoading] = useState(false)
  const [schedules, setSchedules]      = useState<ScheduleItem[]>([])

  const [schedFetchedCreatedDate, setSchedFetchedCreatedDate] = useState<Date | null>(null)
  const [schedDateFetching, setSchedDateFetching]             = useState(false)
  const schedForEdited = useRef(false)

  // Creation date: parsed from name (fast) OR fetched from Terminus (fallback)
  const schedCreatedDate = useMemo(
    () => parseMuSourceDate(schedSource) ?? schedFetchedCreatedDate,
    [schedSource, schedFetchedCreatedDate],
  )
  const schedDefaultDate = useMemo(() => {
    if (!schedCreatedDate || isNaN(schedCreatedDate.getTime())) return null
    return addBusinessDays(schedCreatedDate, 3)
  }, [schedCreatedDate])

  // When source changes: reset everything and re-evaluate
  useEffect(() => {
    schedForEdited.current = false
    setSchedFetchedCreatedDate(null)
    setSchedFor('')

    // If name has an embedded date we already have what we need — no API call
    if (!schedSource || parseMuSourceDate(schedSource)) return
    // Need both site and source to fetch
    if (!schedSite) return

    const timer = setTimeout(async () => {
      setSchedDateFetching(true)
      try {
        const res = await fetch(
          `/api/multidev-info?site=${encodeURIComponent(schedSite)}&source=${encodeURIComponent(schedSource)}`
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
    }, 600) // debounce — wait for user to finish typing

    return () => clearTimeout(timer)
  }, [schedSite, schedSource])

  // Auto-populate the datetime input once a default date is known; respect manual edits
  useEffect(() => {
    if (schedDefaultDate && !schedForEdited.current) {
      setSchedFor(toDatetimeLocal(schedDefaultDate))
    }
  }, [schedDefaultDate])

  // History state
  const [history, setHistory] = useState<HistoryItem[]>([])

  const consoleRef  = useRef<HTMLDivElement>(null)
  const abortRef    = useRef<AbortController | null>(null)
  const isTerminal  = ['completed', 'failed', 'paused'].includes(deployStatus)

  // Auto-refresh history when a deployment finishes
  useEffect(() => {
    if (['completed', 'failed', 'cancelled', 'paused'].includes(deployStatus)) {
      fetch('/api/deployments').then(r => r.json()).then(setHistory).catch(() => {})
    }
  }, [deployStatus])

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
    if (tab === 'schedule') {
      fetch('/api/schedule').then(r => r.json()).then(setSchedules).catch(() => {})
    }
    if (tab === 'history') {
      fetch('/api/deployments').then(r => r.json()).then(setHistory).catch(() => {})
    }
  }, [tab])

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

  const startDeployment = async () => {
    // Cancel any previous stream before starting a new one
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
        body: JSON.stringify({ site, source, destination }),
      })

      if (!res.ok) {
        const err = await res.json()
        setDeployStatus('failed')
        setLogs([{ type: 'log', logType: 'error', message: err.error ?? 'Failed to start deployment', ts: Date.now() }])
        return
      }

      const id = res.headers.get('X-Job-Id')
      if (id) {
        setJobId(id)
        sessionStorage.setItem('mu-deploy-job-id', id)
      }

      await readSSEStream(res)
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
      await readSSEStream(res)
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

  const runScheduleNow = (item: ScheduleItem) => {
    setSite(item.site)
    setSource(item.source)
    setDestination(item.destination as 'dev' | 'test' | 'live')
    setTab('deploy')
  }

  const submitSchedule = async () => {
    if (!schedSite || !schedSource || !schedFor) return
    setSchedLoading(true)
    await fetch('/api/schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        site: schedSite, source: schedSource, destination: schedDest,
        scheduled_for: schedFor, notes: schedNotes,
      }),
    })
    setSchedSite(''); setSchedSource(''); setSchedFor(''); setSchedNotes('')
    const updated = await fetch('/api/schedule').then(r => r.json())
    setSchedules(updated)
    setSchedLoading(false)
  }

  const TABS: { key: Tab; label: string }[] = [
    { key: 'deploy',   label: 'Deploy' },
    { key: 'schedule', label: 'Schedule' },
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
            </div>
          )}
        </div>
      )}

      {/* ── Schedule tab ────────────────────────────────────────────────────── */}
      {tab === 'schedule' && (
        <div className="space-y-6">
          <div className="rounded-xl border border-pantheon-border bg-pantheon-bg-card p-6 space-y-5">
            <h2 className="font-mono text-sm font-semibold text-pantheon-text">Schedule a Deployment</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label className="font-mono text-xs text-pantheon-text-muted">Site ID</label>
                <input className={inputCls} placeholder="my-pantheon-site" value={schedSite} onChange={e => setSchedSite(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <label className="font-mono text-xs text-pantheon-text-muted">Source</label>
                <input className={inputCls} placeholder="my-feature or dev" value={schedSource} onChange={e => setSchedSource(e.target.value)} />
              </div>
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
                {schedDefaultDate && schedCreatedDate && schedFor !== toDatetimeLocal(schedDefaultDate) && schedFor && (
                  <p className="font-mono text-xs text-pantheon-warning">
                    ⚠ Overriding default — original: {schedDefaultDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                  </p>
                )}
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="font-mono text-xs text-pantheon-text-muted">Notes (optional)</label>
              <input className={inputCls} placeholder="e.g. Sprint 12 release" value={schedNotes} onChange={e => setSchedNotes(e.target.value)} />
            </div>
            <div className="flex items-center justify-between pt-1">
              <p className="font-mono text-xs text-pantheon-text-dim">
                Locally: auto-triggered every minute. Production: schedule a <span className="text-pantheon-yellow">POST /api/cron/trigger</span> call from any cron service.
              </p>
              <button
                onClick={submitSchedule}
                disabled={!schedSite || !schedSource || !schedFor || schedLoading}
                className="rounded-lg bg-pantheon-yellow px-5 py-2.5 font-mono text-sm font-semibold text-black hover:bg-pantheon-yellow-dark disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {schedLoading ? 'Saving...' : '+ Schedule'}
              </button>
            </div>
          </div>

          {schedules.length > 0 && (
            <div className="space-y-3">
              <h2 className="font-mono text-xs font-semibold uppercase tracking-widest text-pantheon-text-muted">
                Upcoming
              </h2>
              {schedules.map(s => (
                <ScheduleCard key={s.id} item={s} onCancel={cancelSchedule} onRunNow={runScheduleNow} />
              ))}
            </div>
          )}

          {schedules.length === 0 && (
            <p className="font-mono text-sm text-pantheon-text-dim text-center py-8">
              No scheduled deployments
            </p>
          )}
        </div>
      )}

      {/* ── History tab ─────────────────────────────────────────────────────── */}
      {tab === 'history' && (
        <div className="space-y-3">
          {history.length === 0 && (
            <p className="font-mono text-sm text-pantheon-text-dim text-center py-8">
              No deployment history
              {!process.env.NEXT_PUBLIC_SUPABASE_URL && ' — configure Supabase to enable history'}
            </p>
          )}
          {history.map(item => <HistoryCard key={item.id} item={item} />)}
        </div>
      )}
    </div>
  )
}
