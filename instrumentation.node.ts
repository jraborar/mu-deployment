import { ensureStarted } from '@/lib/startup'
import { startSocketMode } from '@/lib/socketMode'

/**
 * Node.js-only startup. instrumentation.ts already documented that this file
 * held it — the file just did not exist, so only Socket Mode was ever started
 * at boot and the deployment scheduler waited for a request that might never
 * come. See lib/startup.ts for what that cost.
 *
 * Failures are logged, never thrown: instrumentation runs before the server
 * accepts traffic, and a Supabase hiccup at boot must not stop the app from
 * serving. The route's own call to ensureStarted() remains as the fallback.
 */
export async function register(): Promise<void> {
  await startSocketMode()

  try {
    await ensureStarted()
  } catch (err) {
    console.error('[startup] ensureStarted failed at boot — the /api/cron/trigger fallback still applies:', err)
  }
}
