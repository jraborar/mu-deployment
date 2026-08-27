'use client'

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Rocket, Calendar, Clock, History, ChevronUp, ChevronDown, RefreshCw, Layers, Globe, Plus, Trash2, ExternalLink } from 'lucide-react'
import { computeStages, parseMuSourceDate, addBusinessDays, toDatetimeLocal } from '@/lib/pipeline'
import Header from '@/app/components/Header'

// mu-vrt hosts the per-site VRT config (paths + threshold). The registry rows
// link out to it; override per environment if the service URL changes.
const MU_VRT_URL = process.env.NEXT_PUBLIC_MU_VRT_URL || 'https://mu-vrt-production.up.railway.app'

// ── Types ──────────────────────────────────────────────────────────────────────

type DeployStatus = 'idle' | 'running' | 'awaiting-approval' | 'paused' | 'completed' | 'failed'
type ApprovalType = 'alignment' | 'stage'
type Tab = 'sites' | 'deploy' | 'schedule' | 'upcoming' | 'history'

type Platform = 'wp-single' | 'wp-multisite' | 'drupal'

interface Site {
  site: string
  site_name?: string | null
  platform: Platform
  parent_site?: string | null
  php_version?: string | null
  upstream?: string | null
  skip_upstream: boolean
  skip_plugins_themes: boolean
  deploy_days: number
  deploy_destination: 'dev' | 'test' | 'live' | 'multidev'
  deploy_approval: 'manual' | 'auto'
  vrt_paths: string[]
  active: boolean
  paused_at?: string | null
  notes?: string | null
  created_at?: string
  updated_at?: string
}

const PLATFORM_LABELS: Record<Platform, string> = {
  'wp-single':    'WordPress',
  'wp-multisite': 'WP Multisite',
  'drupal':       'Drupal',
}

interface SiteFormState {
  site: string
  platform: Platform
  deploy_destination: 'dev' | 'test' | 'live' | 'multidev'
  deploy_approval: 'manual' | 'auto'
  deploy_days: number
  skip_upstream: boolean
  skip_plugins_themes: boolean
  vrt_paths_text: string
  notes: string
}

const emptySiteForm: SiteFormState = {
  site: '', platform: 'wp-single', deploy_destination: 'live', deploy_approval: 'manual', deploy_days: 1,
  skip_upstream: false, skip_plugins_themes: false, vrt_paths_text: '', notes: '',
}

const SITES_PER_PAGE = 5

function SitesTab() {
  const [sites, setSites]         = useState<Site[]>([])
  const [loading, setLoading]     = useState(true)
  const [editing, setEditing]     = useState<string | null>(null) // site machine-name, or '__new__'
  const [form, setForm]           = useState<SiteFormState>(emptySiteForm)
  const [saving, setSaving]       = useState(false)
  const [busy, setBusy]           = useState<string | null>(null)
  const [error, setError]         = useState<string | null>(null)
  const [activeOpen, setActiveOpen]     = useState(true)
  const [inactiveOpen, setInactiveOpen] = useState(true)
  const [activePage, setActivePage]     = useState(0)
  const [inactivePage, setInactivePage] = useState(0)

  const inputCls = 'w-full rounded-lg border border-slate-600 bg-slate-700 px-3 py-2 font-mono text-sm text-white placeholder-slate-500 focus:border-pantheon-yellow focus:outline-none'
  const labelCls = 'text-xs text-slate-400 font-mono'

  const loadSites = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/sites')
      if (res.ok) setSites(await res.json())
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { void loadSites() }, [loadSites])

  // Read-only display of the VRT paths (owned by the VRT app). Not written from here.
  const vrtPaths = form.vrt_paths_text.split('\n').map(p => p.trim()).filter(Boolean)

  const openNew  = () => { setForm(emptySiteForm); setEditing('__new__'); setError(null) }
  const openEdit = (s: Site) => {
    setForm({
      site: s.site, platform: s.platform, deploy_destination: s.deploy_destination,
      deploy_approval: s.deploy_approval ?? 'manual',
      deploy_days: s.deploy_days, skip_upstream: s.skip_upstream,
      skip_plugins_themes: s.skip_plugins_themes,
      vrt_paths_text: (s.vrt_paths ?? []).join('\n'), notes: s.notes ?? '',
    })
    setEditing(s.site); setError(null)
  }

  const save = async () => {
    if (!form.site.trim()) return
    setSaving(true); setError(null)
    try {
      const payload = {
        site: form.site.trim(), platform: form.platform,
        deploy_destination: form.deploy_destination, deploy_approval: form.deploy_approval,
        deploy_days: form.deploy_days,
        skip_upstream: form.skip_upstream, skip_plugins_themes: form.skip_plugins_themes,
        // vrt_paths deliberately NOT sent — the VRT app owns that config now and this
        // form only displays it (mirrors mu-wp-staging).
        notes: form.notes.trim() || null,
      }
      const isNew = editing === '__new__'
      const res = await fetch(isNew ? '/api/sites' : `/api/sites/${encodeURIComponent(form.site)}`, {
        method: isNew ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) { setError((await res.json().catch(() => ({}))).error ?? `Failed (HTTP ${res.status})`); return }
      setEditing(null); await loadSites()
    } finally { setSaving(false) }
  }

  const toggleActive = async (s: Site) => {
    setBusy(s.site)
    try {
      await fetch(`/api/sites/${encodeURIComponent(s.site)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: !s.active }),
      })
      await loadSites()
    } finally { setBusy(null) }
  }

  const reSync = async (s: Site) => {
    setBusy(s.site)
    try {
      await fetch('/api/sites', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ site: s.site }),
      })
      await loadSites()
    } finally { setBusy(null) }
  }

  const remove = async (s: Site) => {
    setBusy(s.site)
    try {
      await fetch(`/api/sites/${encodeURIComponent(s.site)}`, { method: 'DELETE' })
      await loadSites()
    } finally { setBusy(null) }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Globe className="w-4 h-4 text-slate-400" />
          <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-widest">Sites Registry</h3>
        </div>
        <button onClick={openNew}
          className="flex items-center gap-1.5 rounded-lg bg-pantheon-yellow hover:opacity-90 px-3 py-1.5 text-xs font-semibold text-slate-900 transition-opacity">
          <Plus className="w-3.5 h-3.5" />
          Register Site
        </button>
      </div>

      <p className="text-xs text-slate-500">Shared with WP Staging — register or edit here or there, same data.</p>

      {editing && (
        <div className="rounded-xl border border-slate-700 bg-slate-800 overflow-visible">
          <div className="flex items-center gap-3 px-6 py-4 border-b border-slate-700">
            <Globe className="w-5 h-5 text-pantheon-yellow" />
            <div>
              <h4 className="text-sm font-semibold text-white">{editing === '__new__' ? 'Register Site' : `Edit ${form.site}`}</h4>
              {editing === '__new__' && <p className="text-xs text-slate-400">Name, PHP version &amp; upstream are auto-resolved from Pantheon.</p>}
            </div>
          </div>
          <div className="px-6 py-5 space-y-4">
            {editing === '__new__' && (
              <div className="space-y-1.5">
                <label className={labelCls}>Site ID <span className="text-slate-600 normal-case">(Pantheon machine name)</span></label>
                <input type="text" value={form.site} onChange={e => setForm(f => ({ ...f, site: e.target.value }))}
                  placeholder="my-site-name" className={inputCls} />
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className={labelCls}>Platform</label>
                <select value={form.platform} onChange={e => setForm(f => ({ ...f, platform: e.target.value as Platform }))} className={inputCls}>
                  {(Object.keys(PLATFORM_LABELS) as Platform[]).map(p => <option key={p} value={p}>{PLATFORM_LABELS[p]}</option>)}
                </select>
              </div>
              <div className="space-y-1.5">
                <label className={labelCls}>Deploy to</label>
                <select value={form.deploy_destination} onChange={e => setForm(f => ({ ...f, deploy_destination: e.target.value as SiteFormState['deploy_destination'] }))} className={inputCls}>
                  <option value="live">Live</option>
                  <option value="test">Test</option>
                  <option value="dev">Dev</option>
                  <option value="multidev">Multidev (no deploy)</option>
                </select>
              </div>
            </div>

            <div className="space-y-1.5">
              <label className={labelCls}>Deploy after (business days)</label>
              <select value={form.deploy_days} onChange={e => setForm(f => ({ ...f, deploy_days: Number(e.target.value) }))} className={inputCls}>
                <option value={1}>1 business day</option>
                <option value={2}>2 business days</option>
                <option value={3}>3 business days</option>
                <option value={5}>5 business days (1 week)</option>
              </select>
            </div>

            <div className="space-y-1.5">
              <label className={labelCls}>Deploy approval</label>
              <select value={form.deploy_approval} onChange={e => setForm(f => ({ ...f, deploy_approval: e.target.value as SiteFormState['deploy_approval'] }))} className={inputCls}>
                <option value="manual">Manual — pause at approval gate</option>
                <option value="auto">Auto — run through gates unattended</option>
              </select>
              <p className="text-xs text-slate-500">Applies to scheduled deploys. Manual pauses for a human (+ Slack notice); auto proceeds through the stage gates.</p>
            </div>

            <div className="space-y-2 pt-1 border-t border-slate-700">
              <p className="text-xs text-slate-400 font-mono pt-1">Update defaults</p>
              <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
                <input type="checkbox" checked={form.skip_upstream} onChange={e => setForm(f => ({ ...f, skip_upstream: e.target.checked }))}
                  className="rounded border-slate-600 bg-slate-700 accent-pantheon-yellow" />
                Skip upstream updates
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
                <input type="checkbox" checked={form.skip_plugins_themes} onChange={e => setForm(f => ({ ...f, skip_plugins_themes: e.target.checked }))}
                  className="rounded border-slate-600 bg-slate-700 accent-pantheon-yellow" />
                Skip plugins &amp; themes
              </label>
            </div>

            <div className="space-y-1.5 pt-1 border-t border-slate-700">
              <label className={labelCls}>VRT paths <span className="text-slate-600 normal-case">(managed in the VRT app — read-only here)</span></label>
              {vrtPaths.length > 0 ? (
                <div className="rounded-lg border border-slate-700 bg-slate-900/40 px-3 py-2 font-mono text-xs text-slate-300 max-h-32 overflow-y-auto space-y-0.5">
                  {vrtPaths.map((p, i) => <div key={i}>{p}</div>)}
                </div>
              ) : (
                <p className="font-mono text-xs text-slate-500">No VRT paths configured.</p>
              )}
              {editing !== '__new__' && (
                <a href={`${MU_VRT_URL}/vrt/${encodeURIComponent(form.site)}`} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-pantheon-yellow hover:underline">
                  Edit paths, thresholds &amp; exclusions in the VRT app <ExternalLink className="w-3 h-3" />
                </a>
              )}
            </div>

            <div className="space-y-1.5">
              <label className={labelCls}>Notes <span className="text-slate-600 normal-case">(optional)</span></label>
              <input type="text" value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="anything worth noting" className={inputCls} />
            </div>

            {error && <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 font-mono text-xs text-red-400">{error}</div>}

            <div className="flex gap-2 pt-2">
              <button onClick={save} disabled={saving || !form.site.trim()}
                className="flex-1 rounded-lg bg-pantheon-yellow hover:opacity-90 px-4 py-2.5 text-sm font-semibold text-slate-900 transition-opacity disabled:opacity-40">
                {saving ? 'Saving…' : editing === '__new__' ? 'Register Site' : 'Save Changes'}
              </button>
              <button onClick={() => setEditing(null)} className="px-4 py-2.5 text-sm text-slate-400 hover:text-white transition-colors">Cancel</button>
            </div>
          </div>
        </div>
      )}

      {loading && sites.length === 0 && <p className="text-sm text-slate-500 font-mono text-center py-6">Loading…</p>}
      {!loading && sites.length === 0 && (
        <div className="text-center py-8 space-y-2">
          <Globe className="w-8 h-8 text-slate-600 mx-auto" />
          <p className="text-sm text-slate-500">No sites registered yet — add one above</p>
        </div>
      )}

      {(() => {
        // A site is paused if it has an active hold (paused_at set by mu-wp-staging)
        // OR if its active flag is false. Mirrors isPaused() in mu-wp-staging/lib/sites.ts.
        const isPaused = (s: Site) => !!s.paused_at || !s.active
        const activeSites = sites.filter(s => !isPaused(s))
        const pausedSites = sites.filter(s => isPaused(s))

        const renderRow = (s: Site) => (
          <div key={s.site} className="rounded-xl border border-slate-700 bg-slate-800 overflow-hidden">
            <div className="flex items-center gap-3 px-5 py-3">
              <div className="flex-1 min-w-0">
                <span className="font-mono text-sm text-white">{s.site_name ?? s.site}</span>
                {s.site_name && <span className="ml-2 text-xs text-slate-500 font-mono">{s.site}</span>}
                <div className="flex flex-wrap gap-1.5 mt-1">
                  <span className="text-xs rounded bg-slate-700 px-2 py-0.5 text-slate-300">{PLATFORM_LABELS[s.platform]}</span>
                  {s.php_version && <span className="text-xs rounded bg-slate-700 px-2 py-0.5 text-slate-400">PHP {s.php_version}</span>}
                  {s.upstream && <span className="text-xs rounded bg-slate-700 px-2 py-0.5 text-slate-400">{s.upstream}</span>}
                  <span className="text-xs rounded bg-slate-700 px-2 py-0.5 text-slate-400">→ {s.deploy_destination} · +{s.deploy_days}bd</span>
                  {(s.deploy_approval ?? 'manual') === 'auto' && <span className="text-xs rounded bg-amber-900/40 px-2 py-0.5 text-amber-300">⚡ auto-deploy</span>}
                  {(s.vrt_paths?.length ?? 0) > 0 && <span className="text-xs rounded bg-slate-700 px-2 py-0.5 text-slate-400">{s.vrt_paths.length} VRT</span>}
                </div>
              </div>
              <button onClick={() => reSync(s)} disabled={busy === s.site}
                className="text-slate-500 hover:text-slate-300 transition-colors disabled:opacity-40" title="Re-sync from Pantheon">
                <RefreshCw className={`w-4 h-4 ${busy === s.site ? 'animate-spin' : ''}`} />
              </button>
              <button onClick={() => openEdit(s)} className="text-xs text-slate-400 hover:text-white transition-colors">Edit</button>
              <a href={`${MU_VRT_URL}/vrt/${encodeURIComponent(s.site)}`} target="_blank" rel="noopener noreferrer"
                className="text-xs text-slate-400 hover:text-sky-300 transition-colors inline-flex items-center gap-1" title="Configure VRT (paths + threshold)">
                <Globe className="w-3.5 h-3.5" /> VRT
              </a>
              <button onClick={() => toggleActive(s)} disabled={busy === s.site}
                className={`text-xs px-2 py-0.5 rounded border transition-colors ${s.active ? 'border-green-700 text-green-400 hover:bg-green-900/30' : 'border-slate-600 text-slate-500 hover:bg-slate-700'}`}>
                {s.active ? 'Active' : 'Paused'}
              </button>
              <button onClick={() => remove(s)} disabled={busy === s.site}
                className="text-red-500 hover:text-red-400 transition-colors disabled:opacity-40" title="Remove from registry">
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>
        )

        const renderGroup = (
          label: string,
          dotCls: string,
          labelCls: string,
          group: Site[],
          open: boolean,
          setOpen: (v: boolean) => void,
          page: number,
          setPage: (v: number) => void,
        ) => {
          const totalPages = Math.ceil(group.length / SITES_PER_PAGE)
          const paged = group.slice(page * SITES_PER_PAGE, (page + 1) * SITES_PER_PAGE)
          return (
            <div className="space-y-2">
              <button onClick={() => setOpen(!open)}
                className="flex items-center gap-2 w-full text-left px-3 py-2 rounded-lg bg-slate-800/60 hover:bg-slate-800 border border-slate-700/50 transition-colors group">
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${dotCls}`} />
                <span className={`text-xs font-semibold uppercase tracking-widest ${labelCls}`}>{label}</span>
                <span className="text-xs text-slate-500 font-mono">({group.length})</span>
                <span className="ml-auto text-slate-500 group-hover:text-slate-300 transition-colors">
                  {open ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                </span>
              </button>
              {open && (
                <div className="space-y-2 pl-1">
                  {paged.length === 0
                    ? <p className="text-xs text-slate-600 font-mono pl-3 py-2">No sites</p>
                    : paged.map(renderRow)
                  }
                  {totalPages > 1 && (
                    <div className="flex items-center justify-center gap-3 pt-1">
                      <button onClick={() => setPage(Math.max(0, page - 1))} disabled={page === 0}
                        className="text-xs text-slate-500 hover:text-slate-300 disabled:opacity-30 transition-colors">← Prev</button>
                      <span className="text-xs text-slate-600 font-mono">{page + 1} / {totalPages}</span>
                      <button onClick={() => setPage(Math.min(totalPages - 1, page + 1))} disabled={page >= totalPages - 1}
                        className="text-xs text-slate-500 hover:text-slate-300 disabled:opacity-30 transition-colors">Next →</button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        }

        return (
          <>
            {renderGroup('Active', 'bg-green-500', 'text-green-400', activeSites, activeOpen, setActiveOpen, activePage, setActivePage)}
            {renderGroup('Paused', 'bg-slate-500', 'text-slate-400', pausedSites, inactiveOpen, setInactiveOpen, inactivePage, setInactivePage)}
          </>
        )
      })()}
    </div>
  )
}

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

interface StagingUpcomingItem {
  id: string
  site: string
  site_name?: string
  cadence: string
  at: string
  skip_upstream: boolean
  skip_plugins_themes: boolean
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
  approvalType, message, nextStage, approveLabel, rejectLabel, onApprove, onReject,
}: {
  approvalType: ApprovalType | null
  message: string
  nextStage?: string | null
  approveLabel?: string | null
  rejectLabel?: string | null
  onApprove: () => void
  onReject: () => void
}) {
  const isAlignment = approvalType === 'alignment'
  const defaultApprove = isAlignment ? '↙ Merge' : `✓ Deploy to ${nextStage}`
  const defaultReject  = isAlignment ? 'Cancel'  : '⏸ Pause here'
  return (
    <div className="animate-slide-up rounded-xl border border-pantheon-yellow/40 bg-pantheon-yellow/5 p-5">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-pantheon-yellow">{isAlignment ? '⚠' : '◈'}</span>
        <span className="font-mono text-sm font-semibold text-pantheon-yellow">
          {isAlignment ? 'Action required' : `Ready to deploy to ${nextStage}`}
        </span>
      </div>
      <p className="mb-4 font-mono text-xs text-pantheon-text-muted">{message}</p>
      <div className="flex gap-3">
        <button
          onClick={onApprove}
          className="rounded-lg bg-pantheon-yellow px-4 py-2 font-mono text-xs font-semibold text-black hover:bg-pantheon-yellow-dark transition-colors"
        >
          {approveLabel ?? defaultApprove}
        </button>
        <button
          onClick={onReject}
          className="rounded-lg border border-pantheon-border px-4 py-2 font-mono text-xs text-pantheon-text-muted hover:border-pantheon-border-hi hover:text-pantheon-text transition-colors"
        >
          {rejectLabel ?? defaultReject}
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
  schedules, editingId, editFor, editNotes, editDest,
  onEdit, onSave, onCancelEdit, onRunNow, onCancel,
  setEditFor, setEditNotes, setEditDest,
}: {
  schedules: ScheduleItem[]
  editingId: string | null
  editFor: string
  editNotes: string
  editDest: string
  onEdit: (item: ScheduleItem) => void
  onSave: (id: string) => void
  onCancelEdit: () => void
  onRunNow: (item: ScheduleItem) => void
  onCancel: (id: string) => void
  setEditFor: (v: string) => void
  setEditNotes: (v: string) => void
  setEditDest: (v: string) => void
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
                  {isEditing ? (
                    <select
                      value={editDest}
                      onChange={e => setEditDest(e.target.value)}
                      className="rounded border border-pantheon-border bg-pantheon-bg px-2 py-0.5 font-mono text-xs text-pantheon-text outline-none focus:border-pantheon-yellow"
                    >
                      {['dev','test','live'].map(d => <option key={d} value={d}>{d}</option>)}
                    </select>
                  ) : (
                    <span className="text-pantheon-info">{item.destination}</span>
                  )}
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

function HistoryCard({ item, onResume }: { item: HistoryItem; onResume?: (item: HistoryItem) => void }) {
  const [open, setOpen]       = useState(false)
  const [logs, setLogs]       = useState<LogEntry[] | null>(null)
  const [loading, setLoading] = useState(false)

  const statusColors: Record<string, string> = {
    completed: 'text-green-400',
    failed:    'text-red-400',
    paused:    'text-orange-400',
    cancelled: 'text-slate-500',
    running:   'text-yellow-400',
  }
  const siteColor = statusColors[item.status] ?? 'text-slate-400'
  const endLabel  = item.status === 'failed' ? 'Failed:' : item.status === 'paused' ? 'Paused:' : item.status === 'cancelled' ? 'Cancelled:' : 'Completed:'

  const fmt = (ts: string) =>
    new Date(ts).toLocaleString('en-US', {
      timeZone: 'Asia/Manila', month: 'short', day: 'numeric',
      year: 'numeric', hour: 'numeric', minute: '2-digit',
    })
  const dur = (s: string, e: string) => {
    const m = Math.round((new Date(e).getTime() - new Date(s).getTime()) / 60000)
    return m >= 60 ? `${Math.floor(m/60)}h ${m%60}m` : `${m}m`
  }

  const toggle = async () => {
    const next = !open
    setOpen(next)
    if (next && logs === null) {
      setLoading(true)
      try {
        const res = await fetch(`/api/deployments/${item.id}`)
        if (res.ok) { const data = await res.json(); setLogs((data.logs as LogEntry[]) ?? []) }
      } catch {}
      setLoading(false)
    }
  }

  const keyLogs = logs ? logs.filter(l => ['error', 'warn', 'success'].includes(l.logType)).slice(-5) : []

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800 p-4 space-y-1.5">
      {/* Row 1: Site name + status */}
      <div className="flex items-start justify-between gap-3">
        <div className="truncate">
          <span className={`font-mono text-sm font-semibold ${siteColor}`}>
            {item.site_name ?? item.site}
          </span>
          {item.site_name && (
            <span className="ml-1.5 font-mono font-normal text-slate-500 text-xs">· {item.site}</span>
          )}
        </div>
        <span className={`font-mono text-xs font-semibold shrink-0 ${siteColor}`}>{item.status}</span>
      </div>

      {/* Row 2: Pipeline chips */}
      <div className="font-mono text-xs flex items-center flex-wrap gap-x-2 gap-y-0.5">
        <span className="text-pantheon-yellow">{item.source}</span>
        <span className="text-slate-600">→</span>
        <span className="text-slate-300">{item.destination}</span>
        {item.stages_completed.length > 0 && (
          <>
            <span className="text-slate-600">·</span>
            <span className="text-green-400">{item.stages_completed.join(' → ')} ✓</span>
          </>
        )}
        {item.completed_at && (
          <>
            <span className="text-slate-600">·</span>
            <span className="text-slate-500">{dur(item.started_at, item.completed_at)}</span>
          </>
        )}
      </div>

      {/* Row 3: Timestamps */}
      <div className="flex flex-wrap gap-x-4 font-mono text-xs text-slate-400">
        <span>Started: {fmt(item.started_at)}</span>
        <span>{endLabel} {item.completed_at ? fmt(item.completed_at) : '—'}</span>
      </div>

      {/* Resume button */}
      {item.status === 'paused' && onResume && (
        <button onClick={() => onResume(item)} className="flex items-center gap-1.5 rounded-lg bg-pantheon-yellow hover:bg-pantheon-yellow-dark px-3 py-1.5 text-xs font-semibold text-slate-900 transition-colors">
          ▶ Resume deployment
        </button>
      )}

      {/* Expanded key log entries */}
      {open && (
        <div className="border-t border-slate-700 pt-3 space-y-1.5">
          {loading && <p className="font-mono text-xs text-slate-500">Loading…</p>}
          {logs !== null && keyLogs.length > 0 && keyLogs.map((entry, i) => {
            const style = LOG_STYLES[entry.logType] ?? LOG_STYLES.info
            return (
              <div key={i} className={`font-mono text-xs ${style.cls}`}>
                <span className="opacity-50 mr-1.5">{style.prefix}</span>{entry.message}
              </div>
            )
          })}
          {logs !== null && keyLogs.length === 0 && (
            <p className="font-mono text-xs text-slate-500">No key events recorded.</p>
          )}
        </div>
      )}

      {/* Show Details — bottom-right */}
      <div className="flex justify-end pt-0.5">
        <button onClick={toggle} className="flex items-center gap-1 text-xs text-white hover:text-pantheon-yellow transition-colors">
          {open ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          {open ? 'Hide Details' : 'Show Details'}
        </button>
      </div>
    </div>
  )
}

interface JobApproval {
  approvalType: string
  message: string
  approveLabel?: string | null
  rejectLabel?: string | null
  nextStage?: string | null
}

function RunningJobCard({
  job, logs, siteName, approval, onApprove, onReject, onEvict,
}: {
  job: RunningJobItem
  logs: LogEntry[]
  siteName: string
  approval?: JobApproval | null
  onApprove?: () => void
  onReject?: () => void
  onEvict?: () => void
}) {
  const logRef    = useRef<HTMLDivElement>(null)
  const [open, setOpen]           = useState(true)
  const [confirming, setConfirming] = useState(false)
  const elapsedMin = Math.floor((Date.now() - job.startedAt) / 60000)
  const isPending  = job.status === 'awaiting-approval' && Boolean(approval)

  // Auto-expand when approval is pending
  useEffect(() => { if (isPending) setOpen(true) }, [isPending])

  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logs, open])

  const statusLabel = isPending ? 'awaiting approval' : 'running'
  const statusCls   = isPending ? 'text-pantheon-yellow animate-pulse' : 'text-pantheon-info animate-pulse'

  return (
    <div className="rounded-xl border border-pantheon-border bg-pantheon-bg-card animate-fade-in overflow-hidden">
      {/* Header — always visible, click to expand/collapse */}
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between p-4 text-left hover:bg-pantheon-bg-elevated/40 transition-colors"
      >
        <div className="space-y-0.5 min-w-0">
          <div className="font-mono text-sm font-semibold text-pantheon-info truncate">
            {siteName !== job.site
              ? <>{siteName}<span className="ml-1.5 font-normal text-pantheon-text-dim text-xs">· {job.site}</span></>
              : job.site}
          </div>
          <div className="font-mono text-xs">
            <span className="text-pantheon-yellow">{job.source}</span>
            <span className="mx-1.5 text-pantheon-text-dim">→</span>
            <span className="text-pantheon-info">{job.destination}</span>
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0 ml-3">
          {job.stages.length > 0 && (
            <div className="hidden sm:flex gap-1.5">
              {job.stages.map(stage => {
                const done   = job.completedStages.includes(stage)
                const active = job.currentStage === stage
                return (
                  <span key={stage} className={[
                    'rounded px-1.5 py-0.5 font-mono text-xs border',
                    done   ? 'border-pantheon-success/40 text-pantheon-success' :
                    active ? 'border-pantheon-yellow/40 text-pantheon-yellow' :
                             'border-pantheon-border text-pantheon-text-dim',
                  ].join(' ')}>
                    {done ? '✓' : active ? '⊙' : '○'} {stage}
                  </span>
                )
              })}
            </div>
          )}
          <div className="text-right space-y-0.5">
            <div className={`font-mono text-xs ${statusCls}`}>● {statusLabel}</div>
            <div className="font-mono text-xs text-pantheon-text-dim">{elapsedMin} min</div>
          </div>
          <span className="font-mono text-xs text-pantheon-text-dim">{open ? '▲' : '▼'}</span>
        </div>
      </button>

      {/* Expandable body */}
      {open && (
        <div className="px-4 pb-4 space-y-3 border-t border-pantheon-border">

          {/* Approval prompt */}
          {isPending && approval && onApprove && onReject && (
            <div className="mt-3 rounded-xl border border-pantheon-yellow/40 bg-pantheon-yellow/5 p-4">
              <div className="mb-1 flex items-center gap-2">
                <span className="text-pantheon-yellow">⚠</span>
                <span className="font-mono text-sm font-semibold text-pantheon-yellow">Action required</span>
              </div>
              <p className="mb-3 font-mono text-xs text-pantheon-text-muted">{approval.message}</p>
              <div className="flex gap-2">
                <button
                  onClick={onApprove}
                  className="rounded-lg bg-pantheon-yellow px-4 py-1.5 font-mono text-xs font-semibold text-black hover:bg-pantheon-yellow-dark transition-colors"
                >
                  {approval.approveLabel ?? '✓ Approve'}
                </button>
                <button
                  onClick={onReject}
                  className="rounded-lg bg-pantheon-yellow hover:bg-pantheon-yellow-dark px-4 py-1.5 text-xs font-semibold text-slate-900 hover:text-pantheon-text transition-colors"
                >
                  {approval.rejectLabel ?? '✕ Reject'}
                </button>
              </div>
            </div>
          )}

          {/* Live log */}
          <div ref={logRef} className="h-36 overflow-y-auto bg-pantheon-bg-console rounded p-3 space-y-0.5 mt-3">
            {logs.map((entry, i) => {
              const style = LOG_STYLES[entry.logType] ?? LOG_STYLES.info
              return (
                <div key={i} className={`font-mono text-xs ${style.cls}`}>
                  <span className="opacity-50 mr-1.5">{style.prefix}</span>{entry.message}
                </div>
              )
            })}
            {logs.length === 0 && <span className="font-mono text-xs text-pantheon-text-dim">Connecting...</span>}
            <span className="inline-block h-3 w-1 bg-pantheon-yellow animate-blink" />
          </div>

          {/* Force stop */}
          {onEvict && (
            <div className="flex justify-end">
              {confirming ? (
                <div className="flex gap-1 items-center">
                  <span className="font-mono text-xs text-pantheon-error">Force stop?</span>
                  <button onClick={() => { setConfirming(false); onEvict() }} className="rounded border border-pantheon-error/40 px-2 py-0.5 font-mono text-xs text-pantheon-error hover:bg-pantheon-error/10 transition-colors">Yes</button>
                  <button onClick={() => setConfirming(false)} className="rounded border border-pantheon-border px-2 py-0.5 font-mono text-xs text-pantheon-text-muted hover:bg-pantheon-bg-elevated transition-colors">No</button>
                </div>
              ) : (
                <button onClick={() => setConfirming(true)} className="font-mono text-xs text-pantheon-error/60 hover:text-pantheon-error transition-colors">✕ Force Stop</button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Input + Select shared styles ───────────────────────────────────────────────

const inputCls = [
  'w-full rounded-lg border border-slate-600 bg-slate-700',
  'px-3 py-2 font-mono text-sm text-white placeholder-slate-500',
  'outline-none transition focus:border-pantheon-yellow',
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
  const [approvalType, setApprovalType]   = useState<ApprovalType | null>(null)
  const [approvalMsg, setApprovalMsg]    = useState('')
  const [diffStat, setDiffStat]          = useState<string | undefined>()
  const [nextStage, setNextStage]        = useState<string | null>(null)
  const [approveLabel, setApproveLabel]  = useState<string | null>(null)
  const [rejectLabel, setRejectLabel]    = useState<string | null>(null)

  // Schedule state
  const [schedSites, setSchedSites]    = useState([{ site: '', source: '' }])
  const [schedDest, setSchedDest]      = useState<'dev' | 'test' | 'live'>('live')
  const [schedFor, setSchedFor]        = useState('')
  const [schedNotes, setSchedNotes]    = useState('')
  const [schedConsultant, setSchedConsultant] = useState('')
  const [schedLoading, setSchedLoading] = useState(false)
  const [schedules, setSchedules]      = useState<ScheduleItem[]>([])
  const [showSchedForm, setShowSchedForm] = useState(false)
  const [historyPage, setHistoryPage]  = useState(0)
  const HISTORY_PAGE_SIZE = 5

  // WP Staging upcoming integration
  const [stagingUpcoming, setStagingUpcoming] = useState<StagingUpcomingItem[]>([])
  const [stagingLoading, setStagingLoading]   = useState(false)
  const [stagingOpen, setStagingOpen]         = useState(false)
  const [stagingPage, setStagingPage]         = useState(0)
  const STAGING_PAGE_SIZE = 5
  const [manualSchedOpen, setManualSchedOpen] = useState(false)
  const [manualPage, setManualPage]           = useState(0)
  const MANUAL_PAGE_SIZE = 5

  const [editingId, setEditingId]   = useState<string | null>(null)
  const [editFor, setEditFor]       = useState('')
  const [editNotes, setEditNotes]   = useState('')
  const [editDest, setEditDest]     = useState('live')

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
  const [jobApprovals, setJobApprovals] = useState<Record<string, JobApproval>>({})
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

  // Auto-connect on mount — sessionStorage first, then /api/jobs fallback.
  // Uses reconnectToRef so this effect only fires once (empty deps) without
  // capturing a stale closure.
  useEffect(() => {
    const saved = sessionStorage.getItem('mu-deploy-job-id')
    if (saved) {
      setJobId(saved)
      reconnectToRef.current(saved)
    } else {
      fetch('/api/jobs')
        .then(r => r.json())
        .then((jobs: RunningJobItem[]) => {
          if (jobs.length > 0) {
            setJobId(jobs[0].id)
            reconnectToRef.current(jobs[0].id)
          }
        })
        .catch(() => {})
    }
    fetch('/api/cron/trigger').catch(() => {})
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch schedules, staging upcoming, and history when tabs open
  useEffect(() => {
    if (tab === 'schedule' || tab === 'upcoming') {
      fetch('/api/schedule').then(r => r.json()).then(setSchedules).catch(() => {})
    }
    if (tab === 'upcoming') {
      setStagingLoading(true)
      fetch('/api/staging-upcoming')
        .then(r => r.json())
        .then(data => { setStagingUpcoming(Array.isArray(data) ? data : []); setStagingLoading(false) })
        .catch(() => setStagingLoading(false))
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
    const poll = () => {
      fetch('/api/jobs').then(r => r.json()).then(setRunningJobs).catch(() => {})
      // Also refresh the History list so an in-progress deploy's row/pills update
      // live (previously only re-fetched on tab-open + completion → stale until reload).
      fetch('/api/deployments').then(r => r.json()).then(setHistory).catch(() => {})
    }
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
          if (data.type === 'awaiting-approval') {
            setJobApprovals(prev => ({
              ...prev,
              [job.id]: {
                approvalType: data.approvalType as string,
                message:      data.message as string,
                approveLabel: (data.approveLabel as string) ?? null,
                rejectLabel:  (data.rejectLabel as string) ?? null,
                nextStage:    (data.nextStage as string) ?? null,
              },
            }))
            setJobStages(prev => ({ ...prev, [job.id]: { ...prev[job.id], stages: prev[job.id]?.stages ?? [], completedStages: prev[job.id]?.completedStages ?? [], currentStage: prev[job.id]?.currentStage ?? null, status: 'awaiting-approval' } }))
          }
          if (data.type === 'stage-start' || data.type === 'stage-complete') {
            setJobApprovals(prev => { const n = { ...prev }; delete n[job.id]; return n })
          }
          if (data.type === 'complete') {
            es.close()
            delete connections[job.id]
            setJobApprovals(prev => { const n = { ...prev }; delete n[job.id]; return n })
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
        setApproveLabel((data.approveLabel as string) ?? null)
        setRejectLabel((data.rejectLabel as string) ?? null)
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

  const reconnectTo = useCallback(async (id: string) => {
    abortRef.current?.abort()
    abortRef.current = new AbortController()
    setDeployStatus('running')
    try {
      const res = await fetch(`/api/deploy/${id}`, { signal: abortRef.current.signal })
      if (!res.ok) { reset(); return }
      await streamWithAutoReconnect(res, id)
    } catch (err) {
      if ((err as Error).name !== 'AbortError') reset()
    }
  }, [streamWithAutoReconnect]) // eslint-disable-line react-hooks/exhaustive-deps

  // Stable ref so the mount effect can call reconnectTo without re-running every render
  const reconnectToRef = useRef(reconnectTo)
  useEffect(() => { reconnectToRef.current = reconnectTo }, [reconnectTo])

  const reconnect = async () => {
    if (!jobId) return
    reconnectTo(jobId)
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
    setJobApprovals(prev => { const n = { ...prev }; delete n[id]; return n })
    fetch('/api/deployments').then(r => r.json()).then(setHistory).catch(() => {})
  }

  const sendApprovalForJob = async (id: string, approved: boolean) => {
    await fetch(`/api/approve/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved }),
    })
    setJobApprovals(prev => { const n = { ...prev }; delete n[id]; return n })
    setJobStages(prev => ({ ...prev, [id]: { ...prev[id], status: 'running' } }))
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
    setApproveLabel(null)
    setRejectLabel(null)
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
      body: JSON.stringify({ id, scheduled_for: new Date(editFor + ':00+08:00').toISOString(), notes: editNotes, destination: editDest }),
    })
    setEditingId(null)
    const updated = await fetch('/api/schedule').then(r => r.json())
    setSchedules(updated)
  }

  const scheduleFromStaging = (item: StagingUpcomingItem) => {
    // Pre-fill the schedule form with the site and default source
    // Source will be mu-YYMMDD format — WP Staging creates this multidev
    const today = new Date()
    const yy = String(today.getFullYear()).slice(2)
    const mm = String(today.getMonth() + 1).padStart(2, '0')
    const dd = String(today.getDate()).padStart(2, '0')
    setSchedSites([{ site: item.site, source: `mu-${yy}${mm}${dd}` }])
    setSchedDest('live')
    setShowSchedForm(true)
    setTab('schedule')
  }

  const runScheduleNow = (item: ScheduleItem) => {
    setSite(item.site)
    setSource(item.source)
    setDestination(item.destination as 'dev' | 'test' | 'live')
    setTab('deploy')
  }

  const resumePaused = (item: HistoryItem) => {
    const resumeSource = item.stages_completed[item.stages_completed.length - 1] ?? item.source
    setSite(item.site)
    setSource(resumeSource)
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
    { key: 'sites',    label: 'Sites' },
    { key: 'deploy',   label: 'Deploy' },
    { key: 'schedule', label: 'Schedule' },
    { key: 'upcoming', label: 'Upcoming' },
    { key: 'history',  label: 'History' },
  ]

  const DEST_OPTS = ['dev', 'test', 'live'] as const

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Shared MU header — brand block + context-aware app switcher */}
      <Header current="deployment" />

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-slate-700">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={[
              'relative px-4 py-2 text-sm font-medium transition-colors',
              tab === t.key
                ? 'border-b-2 border-pantheon-yellow text-pantheon-yellow'
                : 'text-slate-400 hover:text-slate-200',
            ].join(' ')}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Sites tab ─────────────────────────────────────────────────────────── */}
      {tab === 'sites' && <SitesTab />}

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
                <button onClick={reset} className="rounded-lg bg-pantheon-yellow hover:bg-pantheon-yellow-dark px-4 py-1.5 text-xs font-semibold text-slate-900">
                  Dismiss
                </button>
              </div>
            </div>
          )}

          {/* Config form */}
          {(deployStatus === 'idle' || deployStatus === 'paused') && (
            <div className="rounded-xl border border-slate-700 bg-slate-800 overflow-hidden">
              {/* Card header */}
              <div className="px-6 py-5 border-b border-slate-700">
                <div className="flex items-center gap-2 mb-1">
                  <Rocket className="w-5 h-5 text-pantheon-yellow" />
                  <h2 className="text-white font-semibold">Run Deployment</h2>
                </div>
                <p className="text-slate-400 text-sm">Deploy a multidev through the pipeline with per-stage approval gates</p>
              </div>

              <div className="px-6 py-5 space-y-5">
                {deployStatus === 'paused' && (
                  <div className="rounded-lg border border-pantheon-warning/40 bg-pantheon-warning/5 px-4 py-3 text-xs text-pantheon-warning">
                    ⏸ Paused after {completedStages[completedStages.length - 1] ?? 'start'} — update source to resume from where it left off.
                  </div>
                )}

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <label className="text-xs text-slate-400 font-mono">Site ID</label>
                    <input
                      className={inputCls}
                      placeholder="my-pantheon-site"
                      value={site}
                      onChange={e => setSite(e.target.value)}
                      disabled={deployStatus !== 'idle'}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs text-slate-400 font-mono">
                      Source <span className="text-slate-600 normal-case font-normal">(multidev, dev, test or live)</span>
                    </label>
                    <input
                      className={inputCls}
                      placeholder="autopilot or dev"
                      value={source}
                      onChange={e => setSource(e.target.value)}
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs text-slate-400 font-mono">
                    Commit label <span className="text-slate-600 normal-case font-normal">(used in "Deployed from …")</span>
                  </label>
                  <input
                    className={inputCls}
                    placeholder="e.g. autopilot"
                    value={label}
                    onChange={e => setLabel(e.target.value)}
                  />
                </div>

                <div className="space-y-1.5 pt-1 border-t border-slate-700">
                  <label className="text-xs text-slate-400 font-mono pt-1">Final destination</label>
                  <div className="flex gap-2">
                    {DEST_OPTS.map(d => (
                      <button
                        key={d}
                        onClick={() => setDestination(d)}
                        className={[
                          'rounded-lg border px-4 py-2 text-sm transition-colors',
                          destination === d
                            ? 'border-pantheon-yellow bg-pantheon-yellow/10 text-pantheon-yellow font-medium'
                            : 'border-slate-600 text-slate-400 hover:border-slate-500 hover:text-slate-200',
                        ].join(' ')}
                      >
                        {d}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="pt-2 border-t border-slate-700 space-y-3">
                  <p className="text-xs text-slate-500 font-mono">
                    Pipeline: <span className="text-slate-300">{computeStages(source, destination).join(' → ') || '—'}</span>
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={startDeployment}
                      disabled={!site || !source}
                      className="flex-1 flex items-center justify-center gap-2 rounded-lg bg-pantheon-yellow py-2.5 text-sm font-semibold text-slate-900 hover:bg-pantheon-yellow-dark disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      <Rocket className="w-4 h-4" />
                      Start Deployment
                    </button>
                    {deployStatus === 'paused' && (
                      <button onClick={reset} className="px-4 py-2.5 text-sm text-slate-400 hover:text-white transition-colors">
                        Cancel
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Pipeline bar */}
          {stages.length > 0 && (
            <div className="rounded-xl border border-slate-700 bg-slate-800 px-6 py-5">
              <div className="mb-4 flex items-center justify-between">
                <span className="font-mono text-xs font-semibold uppercase tracking-widest text-pantheon-text-muted">
                  Pipeline
                </span>
                <div className="flex gap-2">
                  {!isTerminal && deployStatus !== 'idle' && (
                    <button
                      onClick={cancelDeployment}
                      className="rounded border border-red-500/40 px-3 py-1 text-xs text-red-400 hover:bg-red-500/10 transition-colors"
                    >
                      ✕ Stop
                    </button>
                  )}
                  {isTerminal && (
                    <button
                      onClick={reset}
                      className="rounded border border-slate-600 px-3 py-1 text-xs text-slate-400 hover:border-slate-500 hover:text-slate-200 transition-colors"
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
              nextStage={nextStage}
              approveLabel={approveLabel}
              rejectLabel={rejectLabel}
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
            <div className="rounded-xl border border-slate-700 overflow-hidden">
              <div className="flex items-center gap-2 border-b border-slate-700 bg-slate-800 px-4 py-2.5">
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
                className="console-output h-72 overflow-y-auto bg-slate-900 p-4 space-y-0.5"
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
        <div className="space-y-4">
          {/* Section header + toggle button — WP Staging pattern */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Calendar className="w-4 h-4 text-slate-400" />
              <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-widest">Scheduled Deployments</h3>
            </div>
            <button
              onClick={() => setShowSchedForm(f => !f)}
              className="flex items-center gap-1.5 rounded-lg bg-pantheon-yellow hover:bg-pantheon-yellow-dark px-3 py-1.5 text-xs font-semibold text-slate-900 transition-colors"
            >
              <Calendar className="w-3.5 h-3.5" />
              {showSchedForm ? 'Cancel' : '+ Add Schedule'}
            </button>
          </div>

          {/* Form — hidden until button clicked */}
          {showSchedForm && (
          <div className="rounded-xl border border-slate-700 bg-slate-800 overflow-hidden">
            <div className="px-6 py-5 border-b border-slate-700">
              <div className="flex items-center gap-2 mb-1">
                <Calendar className="w-5 h-5 text-slate-400" />
                <h2 className="text-slate-400 font-semibold uppercase tracking-widest text-sm">Schedule a Deployment</h2>
              </div>
              <p className="text-slate-500 text-sm">Auto-triggered by the scheduler at the specified Manila time</p>
            </div>
            <div className="px-6 py-5 space-y-5">

            {/* Sites */}
            <div className="space-y-2">
              <div className="grid grid-cols-[1fr_1fr_auto] gap-2 items-center">
                <span className="text-xs text-slate-400 font-mono">Site ID</span>
                <span className="text-xs text-slate-400 font-mono">Source</span>
                <span />
              </div>
              {schedSites.map((row, i) => {
                const isDuplicate = row.site && schedules.some(s => s.site === row.site)
                return (
                  <div key={i} className="space-y-1">
                    <div className="grid grid-cols-[1fr_1fr_auto] gap-2 items-center">
                      <input className={inputCls} placeholder="my-pantheon-site" value={row.site} onChange={e => setSchedSites(prev => prev.map((s, idx) => idx === i ? { ...s, site: e.target.value } : s))} />
                      <input className={inputCls} placeholder="autopilot or dev" value={row.source} onChange={e => setSchedSites(prev => prev.map((s, idx) => idx === i ? { ...s, source: e.target.value } : s))} />
                      <button onClick={() => setSchedSites(prev => prev.length > 1 ? prev.filter((_, idx) => idx !== i) : prev)} disabled={schedSites.length === 1} className="rounded border border-slate-600 px-2 py-2 text-xs text-slate-400 hover:border-red-500/40 hover:text-red-400 disabled:opacity-30 transition-colors">✕</button>
                    </div>
                    {isDuplicate && <p className="text-xs text-pantheon-warning font-mono pl-1">⚠ {row.site} already has a pending schedule.</p>}
                  </div>
                )
              })}
              <button onClick={() => setSchedSites(prev => [...prev, { site: '', source: '' }])} className="text-xs text-slate-400 hover:text-slate-200 transition-colors">
                + Add another site
              </button>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 pt-1 border-t border-slate-700">
              <div className="space-y-1.5 pt-1">
                <label className="text-xs text-slate-400 font-mono">Final destination</label>
                <div className="flex gap-2">
                  {DEST_OPTS.map(d => (
                    <button key={d} onClick={() => setSchedDest(d)} className={['rounded-lg border px-4 py-2 text-sm transition-colors', schedDest === d ? 'border-pantheon-yellow bg-pantheon-yellow/10 text-pantheon-yellow font-medium' : 'border-slate-600 text-slate-400 hover:border-slate-500 hover:text-slate-200'].join(' ')}>{d}</button>
                  ))}
                </div>
              </div>
              <div className="space-y-1.5 pt-1">
                <div className="flex items-center gap-2">
                  <label className="text-xs text-slate-400 font-mono">Deployment date</label>
                  {schedDateFetching && <span className="text-xs text-slate-500 animate-pulse">looking up...</span>}
                  {schedDefaultDate && schedCreatedDate && !schedDateFetching && (
                    <span className="text-xs text-slate-500">· default <span className="text-pantheon-info">{schedDefaultDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</span></span>
                  )}
                </div>
                <input type="datetime-local" className={inputCls} value={schedFor} onChange={e => { schedForEdited.current = true; setSchedFor(e.target.value) }} />
                {schedDefaultDate && schedCreatedDate && schedFor !== getManilaDefaultFor(schedDefaultDate) && schedFor && (
                  <p className="text-xs text-pantheon-warning font-mono">⚠ Overriding default</p>
                )}
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 pt-1 border-t border-slate-700">
              <div className="space-y-1.5 pt-1">
                <label className="text-xs text-slate-400 font-mono">MU Consultant</label>
                <input className={inputCls} placeholder="e.g. Jasper" value={schedConsultant} onChange={e => setSchedConsultant(e.target.value)} />
              </div>
              <div className="space-y-1.5 pt-1">
                <label className="text-xs text-slate-400 font-mono">Notes (optional)</label>
                <input className={inputCls} placeholder="e.g. Sprint 12 release" value={schedNotes} onChange={e => setSchedNotes(e.target.value)} />
              </div>
            </div>

            <div className="pt-2 border-t border-slate-700 space-y-3">
              <p className="text-xs text-slate-500 font-mono">Auto-triggered every minute by the scheduler</p>
              <div className="flex gap-2">
                <button onClick={submitSchedule} disabled={!schedSites.some(s => s.site && s.source) || !schedFor || schedLoading} className="flex-1 flex items-center justify-center gap-2 rounded-lg bg-pantheon-yellow py-2.5 text-sm font-semibold text-slate-900 hover:bg-pantheon-yellow-dark disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                  <Calendar className="w-4 h-4" />
                  {schedLoading ? 'Saving…' : 'Schedule Deployment'}
                </button>
                <button onClick={() => { setSchedSites([{ site: '', source: '' }]); setSchedFor(''); setSchedNotes(''); setSchedConsultant('') }} className="px-4 py-2.5 text-sm text-slate-400 hover:text-white transition-colors">
                  Clear
                </button>
              </div>
            </div>
          </div>
          </div>
          )} {/* end showSchedForm */}

          {/* Existing schedules as cards */}
          {schedules.length === 0 && !showSchedForm && (
            <div className="text-center py-8 space-y-2">
              <Calendar className="w-8 h-8 text-slate-600 mx-auto" />
              <p className="text-sm text-slate-500">No scheduled deployments — click + Add Schedule to add one</p>
            </div>
          )}
          {schedules.map(item => (
            <div key={item.id} className="rounded-xl border border-slate-700 bg-slate-800 overflow-hidden">
              <div className="flex items-center gap-3 px-5 py-3">
                <div className="flex-1 min-w-0">
                  <span className="font-mono text-sm text-white">{item.site_name ?? item.site}</span>
                  <p className="font-mono text-xs text-slate-400 mt-0.5">{item.source} → {item.destination}</p>
                </div>
                <div className="hidden sm:flex flex-col items-end text-xs text-slate-500">
                  <span className="text-slate-300">{new Date(item.scheduled_for).toLocaleString('en-US', { timeZone: 'Asia/Manila', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
                  {item.notes && <span>{item.notes}</span>}
                </div>
                <button onClick={() => cancelSchedule(item.id)} className="text-red-500 hover:text-red-400 transition-colors ml-1" title="Remove schedule">
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
                </button>
              </div>
            </div>
          ))}

        </div>
      )}

      {/* ── Upcoming tab ─────────────────────────────────────────────────────── */}
      {tab === 'upcoming' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4 text-slate-400" />
              <h3 className="text-sm font-semibold text-white uppercase tracking-widest">Upcoming Deployments</h3>
            </div>
            <button
              onClick={() => fetch('/api/schedule').then(r => r.json()).then(setSchedules).catch(() => {})}
              className="flex items-center gap-1.5 text-xs text-white hover:text-pantheon-yellow transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Refresh
            </button>
          </div>
          {/* ── Upcoming deployments — split by origin (from staging vs manual) ── */}
          {(() => {
            // "From staging" = pre-booked by the staging app (tagged consultant='WP Staging').
            // "Manually scheduled" = created here via the Schedule tab. When staging deploys are
            // later attributed to a real consultant, swap this tag for an explicit `origin` field.
            const stagingDeploys = schedules.filter(s => s.consultant === 'WP Staging')
            const manualDeploys  = schedules.filter(s => s.consultant !== 'WP Staging')

            const deployRow = (item: typeof schedules[number], last: boolean) => {
              const isEditing = editingId === item.id
              return (
                <div key={item.id} className={`p-4 space-y-2 ${!last ? 'border-b border-slate-700/60' : ''}`}>
                  <div className="flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono text-sm font-semibold text-white">{item.site_name ?? item.site}</span>
                        <span className="text-xs rounded border border-pantheon-yellow/40 text-pantheon-yellow px-1.5 py-0.5 font-mono">{item.source} → {item.destination}</span>
                      </div>
                      {!isEditing && <p className="font-mono text-xs text-slate-300 mt-1">
                        {new Date(item.scheduled_for).toLocaleString('en-US', { timeZone: 'Asia/Manila', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                        <span className="text-slate-500 ml-1">(Manila)</span>
                      </p>}
                      {item.notes && !isEditing && <p className="font-mono text-xs text-slate-500 mt-0.5">{item.notes}</p>}
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {!isEditing && <>
                        <button onClick={() => runScheduleNow(item)} className="rounded-lg bg-pantheon-yellow hover:bg-pantheon-yellow-dark px-2.5 py-1.5 text-xs font-semibold text-slate-900 transition-colors">▶</button>
                        <button onClick={() => { setEditingId(item.id); setEditFor(toManilaDatetimeLocal(item.scheduled_for)); setEditNotes(item.notes ?? ''); setEditDest(item.destination) }} className="rounded border border-slate-600 px-2.5 py-1 text-xs text-slate-400 hover:border-slate-400 transition-colors">✎</button>
                        <button onClick={() => cancelSchedule(item.id)} className="rounded border border-red-500/40 px-2.5 py-1 text-xs text-red-400 hover:bg-red-500/10 transition-colors">✕</button>
                      </>}
                    </div>
                  </div>
                  {isEditing && (
                    <div className="space-y-3 pt-2 border-t border-slate-700">
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div className="space-y-1">
                          <label className="text-xs text-slate-400 font-mono">Date & Time (Manila)</label>
                          <input type="datetime-local" value={editFor} onChange={e => setEditFor(e.target.value)} className="w-full rounded border border-slate-600 bg-slate-700 px-2 py-1.5 font-mono text-xs text-white focus:border-pantheon-yellow focus:outline-none" />
                        </div>
                        <div className="space-y-1">
                          <label className="text-xs text-slate-400 font-mono">Destination</label>
                          <select value={editDest} onChange={e => setEditDest(e.target.value)} className="w-full rounded border border-slate-600 bg-slate-700 px-2 py-1.5 text-xs text-white focus:border-pantheon-yellow focus:outline-none">
                            {['dev','test','live'].map(d => <option key={d} value={d}>{d}</option>)}
                          </select>
                        </div>
                      </div>
                      <input type="text" value={editNotes} onChange={e => setEditNotes(e.target.value)} placeholder="Notes (optional)" className="w-full rounded border border-slate-600 bg-slate-700 px-2 py-1.5 font-mono text-xs text-white placeholder-slate-500 focus:border-pantheon-yellow focus:outline-none" />
                      <div className="flex gap-2">
                        <button onClick={() => saveEdit(item.id)} disabled={!editFor} className="flex-1 rounded-lg bg-pantheon-yellow py-2 text-xs font-semibold text-slate-900 hover:bg-pantheon-yellow-dark disabled:opacity-40 transition-colors">Save</button>
                        <button onClick={() => setEditingId(null)} className="px-4 py-2 text-xs text-slate-400 hover:text-white transition-colors">Cancel</button>
                      </div>
                    </div>
                  )}
                </div>
              )
            }

            const accordion = (
              title: string, dotPulse: boolean, list: typeof schedules,
              open: boolean, setOpen: (v: boolean) => void,
              page: number, setPage: React.Dispatch<React.SetStateAction<number>>, emptyMsg: string,
            ) => {
              const totalPages = Math.max(1, Math.ceil(list.length / MANUAL_PAGE_SIZE))
              const safePage = Math.min(page, totalPages - 1)
              const paged = list.slice(safePage * MANUAL_PAGE_SIZE, (safePage + 1) * MANUAL_PAGE_SIZE)
              return (
                <div className="rounded-xl border border-slate-700 bg-slate-800 overflow-hidden">
                  <button onClick={() => setOpen(!open)} className="w-full flex items-center justify-between px-5 py-3 hover:bg-slate-700/40 transition-colors">
                    <div className="flex items-center gap-2">
                      {dotPulse
                        ? <span className="w-2 h-2 rounded-full bg-pantheon-yellow animate-pulse inline-block" />
                        : <Calendar className="w-4 h-4 text-slate-400" />}
                      <h3 className="text-sm font-semibold text-white uppercase tracking-widest">{title}</h3>
                      {list.length > 0 && <span className="text-xs rounded-full bg-slate-600 text-slate-300 px-2 py-0.5 font-mono">{list.length}</span>}
                    </div>
                    {open ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
                  </button>
                  {open && (
                    <div className="border-t border-slate-700">
                      {list.length === 0
                        ? <p className="text-sm text-slate-500 text-center py-6">{emptyMsg}</p>
                        : (<>
                          {paged.map((item, i) => deployRow(item, i === paged.length - 1))}
                          {totalPages > 1 && (
                            <div className="flex items-center justify-center gap-2 px-5 py-2 border-t border-slate-700/60">
                              <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={safePage === 0} className="rounded border border-slate-600 px-3 py-1 text-xs text-slate-400 hover:border-slate-400 disabled:opacity-30 transition-colors">← Prev</button>
                              <span className="font-mono text-xs text-slate-500">{safePage + 1} / {totalPages}</span>
                              <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={safePage >= totalPages - 1} className="rounded border border-slate-600 px-3 py-1 text-xs text-slate-400 hover:border-slate-400 disabled:opacity-30 transition-colors">Next →</button>
                            </div>
                          )}
                        </>)}
                    </div>
                  )}
                </div>
              )
            }

            return (
              <>
                {accordion('From Staging', true, stagingDeploys, stagingOpen, setStagingOpen, stagingPage, setStagingPage, 'No deployments from staging yet — run a staging job and its deploy appears here.')}
                {accordion('Manually Scheduled', false, manualDeploys, manualSchedOpen, setManualSchedOpen, manualPage, setManualPage, 'No manually scheduled deployments — use the Schedule tab.')}
              </>
            )
          })()}
        </div>
      )}

      {/* ── History tab ─────────────────────────────────────────────────────── */}
      {tab === 'history' && (() => {
        const inMemoryIds    = new Set(runningJobs.map(j => j.id))
        const orphanedRunning = history.filter(item => item.status === 'running' && !inMemoryIds.has(item.id))
        const pastHistory     = history.filter(item => item.status !== 'running')
        const hasLive         = runningJobs.length > 0 || orphanedRunning.length > 0
        return (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <History className="w-4 h-4 text-slate-400" />
                <h3 className="text-sm font-semibold text-white uppercase tracking-widest">Past Deployments</h3>
              </div>
              <button
                onClick={() => fetch('/api/deployments').then(r => r.json()).then(setHistory).catch(() => {})}
                className="flex items-center gap-1.5 text-xs text-white hover:text-pantheon-yellow transition-colors"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Refresh
              </button>
            </div>
            {/* Live — in-memory jobs + orphaned Supabase running records */}
            {hasLive && (
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-yellow-400 uppercase tracking-widest flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse inline-block" />
                  Live
                </h3>
                {runningJobs.map(job => {
                  const liveStages = jobStages[job.id]
                  const siteName   = job.site_name ?? schedules.find(s => s.site === job.site)?.site_name ?? job.site
                  const approval   = jobApprovals[job.id] ?? null
                  return (
                    <RunningJobCard
                      key={job.id}
                      job={liveStages ? { ...job, ...liveStages } : job}
                      logs={jobLogs[job.id] ?? []}
                      siteName={siteName}
                      approval={approval}
                      onApprove={() => sendApprovalForJob(job.id, true)}
                      onReject={() => sendApprovalForJob(job.id, false)}
                      onEvict={() => evictJob(job.id)}
                    />
                  )
                })}
                {orphanedRunning.map(item => <HistoryCard key={item.id} item={item} />)}
              </div>
            )}

            {/* Past — paginated 5 per page */}
            {(() => {
              const totalPages = Math.ceil(pastHistory.length / HISTORY_PAGE_SIZE)
              const paginated  = pastHistory.slice(historyPage * HISTORY_PAGE_SIZE, (historyPage + 1) * HISTORY_PAGE_SIZE)
              return (
                <div className="space-y-3">
                  {hasLive && pastHistory.length > 0 && (
                    <div className="flex items-center gap-2">
                      <Layers className="w-4 h-4 text-slate-400" />
                      <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-widest">Past</h3>
                    </div>
                  )}
                  {!hasLive && pastHistory.length === 0 && (
                    <p className="text-sm text-slate-500 text-center py-12">No deployment history yet</p>
                  )}
                  {paginated.map(item => <HistoryCard key={item.id} item={item} onResume={resumePaused} />)}
                  {totalPages > 1 && (
                    <div className="flex items-center justify-center gap-2 pt-2">
                      <button
                        onClick={() => setHistoryPage(p => Math.max(0, p - 1))}
                        disabled={historyPage === 0}
                        className="rounded border border-slate-600 px-3 py-1 text-xs text-slate-400 hover:border-slate-400 disabled:opacity-30 transition-colors"
                      >← Prev</button>
                      <span className="font-mono text-xs text-slate-500">{historyPage + 1} / {totalPages}</span>
                      <button
                        onClick={() => setHistoryPage(p => Math.min(totalPages - 1, p + 1))}
                        disabled={historyPage >= totalPages - 1}
                        className="rounded border border-slate-600 px-3 py-1 text-xs text-slate-400 hover:border-slate-400 disabled:opacity-30 transition-colors"
                      >Next →</button>
                    </div>
                  )}
                </div>
              )
            })()}
          </div>
        )
      })()}
    </div>
  )
}
