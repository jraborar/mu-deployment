/**
 * One value per PROCESS, not one per module graph.
 *
 * WHY THIS FILE EXISTS
 *
 * Next.js does not give `instrumentation.node.ts` and the route handlers under
 * `app/api/**` the same module registry. Each is bundled into its own graph, so
 * a module imported by both is INSTANTIATED TWICE in one process, and every
 * module-scoped `let`/`new Map()` inside it exists twice with independent
 * values. Nothing warns about this; both copies work perfectly on their own.
 *
 * That cost us a customer deployment on 2026-09-09. `startScheduler()` runs
 * from instrumentation, so `runDueSchedules()` → `createJob()` put the job in
 * the INSTRUMENTATION copy of lib/jobStore's Map. The UI polls `/api/jobs` and
 * streams `/api/deploy/[jobId]`, which are route handlers reading the ROUTE
 * copy — an empty Map. So:
 *
 *   - GET  /api/jobs                 → []            (no card, no buttons)
 *   - GET  /api/deploy/[jobId]       → 404           (no log stream)
 *   - POST /api/approve/[jobId]      → 404           (approval IMPOSSIBLE)
 *
 * tstc-multisite mu-260902 → live stopped at its first approval gate (dev was
 * in SFTP mode) and could not be answered by anyone, through any route, ever.
 * It sat there while `deployment_history` said `running` — because that row is
 * only written on finalize — and the operator saw a "running" card with no way
 * to act on it. The 24h `pruneStaleJobs()` would eventually have marked it
 * failed, having deployed nothing.
 *
 * The same split hit two other singletons:
 *
 *   - lib/startup.ts's `schedulerStarted` / `serverInitDone`: each graph had
 *     its own flags, so BOTH ran. Two schedulers ticked every 60s, `serverInit`
 *     ran twice (two sets of SIGTERM handlers, two boot broadcasts of pending
 *     schedules to Slack). `claimDueSchedules()` is atomic, so this never
 *     double-deployed — it just meant whichever graph won the claim owned a job
 *     the other one could not see.
 *   - lib/socketMode.ts's `started`: two Socket Mode clients connected (visible
 *     in the Railway logs as SlackWebSocket:4 and :8). Slack delivers an
 *     interaction to ONE connection, so a Slack approve button had roughly even
 *     odds of landing in the graph whose store did not hold the job, logging
 *     "Interaction for unknown or already-resolved job".
 *
 * WHAT THIS DOES
 *
 * Hangs the value off `globalThis`, which is genuinely per-process and shared
 * by every graph, keyed under one symbol so the keys cannot collide with
 * anything else on the global object. `Symbol.for` is used deliberately: it
 * resolves through the process-wide symbol registry, so even a second copy of
 * THIS file gets the same symbol and therefore the same bag.
 *
 * WHAT THIS IS NOT FOR
 *
 * Only for state that must be one-per-process: the job store, "have I started
 * the scheduler", "am I already connected to Slack". Lazily-built API clients
 * (lib/slack.ts's `_web`, lib/supabase.ts's `_client`) are fine as they are —
 * duplicating those costs one extra client object and nothing more.
 *
 * It is also not a substitute for durable state. `globalThis` dies with the
 * process, so a Railway redeploy still loses in-flight jobs; that is what the
 * SIGTERM flush in lib/startup.ts and `cleanupStaleRunningRecords()` are for.
 */

const BAG = Symbol.for('mu-deployment.processSingletons')

type Bag = Map<string, unknown>

function bag(): Bag {
  const g = globalThis as typeof globalThis & { [BAG]?: Bag }
  if (!g[BAG]) g[BAG] = new Map<string, unknown>()
  return g[BAG]
}

/**
 * Returns the one instance of `key` for this process, creating it on first use.
 *
 * `create` must be idempotent-safe to skip: on the second module graph it is
 * not called at all, and the value the first graph built is returned instead.
 *
 * For mutable flags, hold them in a returned OBJECT rather than reassigning a
 * local — `processSingleton('x', () => ({ started: false }))` then mutating
 * `.started` is shared; `let started = processSingleton(...)` is not, because
 * the local binding is still per-graph.
 */
export function processSingleton<T>(key: string, create: () => T): T {
  const b = bag()
  if (!b.has(key)) b.set(key, create())
  return b.get(key) as T
}
