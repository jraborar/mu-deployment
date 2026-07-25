import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL  ?? ''
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''

export function isConfigured(): boolean {
  return Boolean(url && key)
}

let _client: SupabaseClient | null = null
function getClient(): SupabaseClient | null {
  if (!isConfigured()) return null
  if (!_client) _client = createClient(url, key)
  return _client
}

export interface DeploymentRecord {
  site: string
  source: string
  destination: string
  stages_completed: string[]
  status: string
  started_at: string
  completed_at: string | null
  logs: object[]
}

export interface ScheduleRecord {
  site: string
  source: string
  destination: string
  scheduled_for: string
  notes?: string
}

export async function createDeploymentRecord(id: string, data: Omit<DeploymentRecord, 'completed_at' | 'logs' | 'stages_completed'>): Promise<void> {
  const db = getClient()
  if (!db) return
  const { error } = await db.from('deployment_history').insert({
    id,
    ...data,
    stages_completed: [],
    status: 'running',
    completed_at: null,
    logs: [],
  })
  if (error) console.error('[supabase] createDeploymentRecord:', error.message)
}

export async function finalizeDeploymentRecord(id: string, updates: Pick<DeploymentRecord, 'status' | 'stages_completed' | 'completed_at' | 'logs'>): Promise<void> {
  const db = getClient()
  if (!db) return
  const { error } = await db.from('deployment_history').update(updates).eq('id', id)
  if (error) console.error('[supabase] finalizeDeploymentRecord:', error.message)
}

export async function saveDeployment(data: DeploymentRecord): Promise<void> {
  const db = getClient()
  if (!db) return
  const { error } = await db.from('deployment_history').insert(data)
  if (error) console.error('[supabase] saveDeployment:', error.message)
}

export async function listDeployments(limit = 20): Promise<DeploymentRecord[]> {
  const db = getClient()
  if (!db) return []
  const { data, error } = await db
    .from('deployment_history')
    .select('*')
    .order('started_at', { ascending: false })
    .limit(limit)
  if (error) console.error('[supabase] listDeployments:', error.message)
  return data ?? []
}

export async function createSchedule(data: ScheduleRecord): Promise<void> {
  const db = getClient()
  if (!db) return
  await db.from('scheduled_deployments').insert(data)
}

export async function listSchedules(): Promise<(ScheduleRecord & { id: string; status: string })[]> {
  const db = getClient()
  if (!db) return []
  const { data } = await db
    .from('scheduled_deployments')
    .select('*')
    .eq('status', 'pending')
    .order('scheduled_for', { ascending: true })
  return data ?? []
}

export async function cancelSchedule(id: string): Promise<void> {
  const db = getClient()
  if (!db) return
  await db.from('scheduled_deployments').update({ status: 'cancelled' }).eq('id', id)
}

// Marks any records stuck as 'running' from a crashed/restarted server instance as failed.
// Safe to call on every startup — a running record with no in-memory counterpart is always orphaned.
export async function cleanupStaleRunningRecords(): Promise<number> {
  const db = getClient()
  if (!db) return 0
  const { data, error } = await db
    .from('deployment_history')
    .update({ status: 'failed', completed_at: new Date().toISOString() })
    .eq('status', 'running')
    .is('completed_at', null)
    .select('id')
  if (error) console.error('[supabase] cleanupStaleRunningRecords:', error.message)
  return data?.length ?? 0
}

// Atomically claims due schedules — updates to 'triggered' and returns only
// the rows this instance claimed, preventing double-firing across instances.
export async function claimDueSchedules(): Promise<(ScheduleRecord & { id: string; status: string })[]> {
  const db = getClient()
  if (!db) return []
  const { data } = await db
    .from('scheduled_deployments')
    .update({ status: 'triggered' })
    .eq('status', 'pending')
    .lte('scheduled_for', new Date().toISOString())
    .select()
  return data ?? []
}
