// Check for lib/staleJobs.ts — the policy deciding which in-flight jobs the
// scheduler kills. No test runner in this repo: `npm run check:stale-jobs`
// (Node strips the types). Times are fixed so assertions never depend on today.
import { isStaleJob, selectStaleJobs, STALE_JOB_MS, type StaleCandidate } from '../lib/staleJobs.ts'

const MIN = 60 * 1000
const HOUR = 60 * MIN
const NOW = Date.parse('2026-09-18T08:01:52Z')

let pass = 0, fail = 0
function check(name: string, actual: unknown, expected: unknown) {
  if (String(actual) === String(expected)) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}\n         got ${actual}\n         want ${expected}`) }
}

const job = (o: Partial<StaleCandidate>): StaleCandidate =>
  ({ status: 'running', lastActivity: NOW, ...o }) as StaleCandidate

console.log('idle clock')
check('active just now → not stale',        isStaleJob(job({ lastActivity: NOW - MIN }), NOW), false)
check('idle 23h → not stale',               isStaleJob(job({ lastActivity: NOW - 23 * HOUR }), NOW), false)
check('idle exactly 24h → not stale',       isStaleJob(job({ lastActivity: NOW - STALE_JOB_MS }), NOW), false)
check('idle 24h + 1ms → stale',             isStaleJob(job({ lastActivity: NOW - STALE_JOB_MS - 1 }), NOW), true)
check('awaiting-approval, idle 25h → stale',isStaleJob(job({ status: 'awaiting-approval', lastActivity: NOW - 25 * HOUR }), NOW), true)

console.log('\nonly in-flight jobs are candidates')
for (const status of ['completed', 'failed', 'paused'] as const) {
  check(`${status}, idle 30h → not stale`, isStaleJob(job({ status, lastActivity: NOW - 30 * HOUR }), NOW), false)
}

// The regression. ApexOrderPickup mu-260915 → live:
//   09-17 08:00:53  job created, deploys to dev
//   09-17 08:10:56  parks at the test approval gate (last activity)
//   09-18 07:58:52  approved; snapshot + deploy to test begins
//   09-18 08:01:52  pruner runs — 24h01m after CREATION, 3m after last activity
// Ageing from creation killed it here, mid-deploy, with test and live to go.
console.log('\nregression: ApexOrderPickup mu-260915 (2026-09-17 → 2026-09-18)')
const createdAt = Date.parse('2026-09-17T08:00:53Z')
const approvedAt = Date.parse('2026-09-18T07:58:52Z')
check('24h01m after creation but 3m after approval → NOT stale',
  isStaleJob(job({ lastActivity: approvedAt }), NOW), false)
check('...and ageing from creation would have killed it',
  NOW - createdAt > STALE_JOB_MS, true)

// The gate it parked at is still genuinely abandonable: if nobody had ever
// approved, the job goes quiet at 08:10:56 and dies a day after THAT.
const parkedAt = Date.parse('2026-09-17T08:10:56Z')
check('never approved, 24h after parking → stale',
  isStaleJob(job({ status: 'awaiting-approval', lastActivity: parkedAt }), parkedAt + STALE_JOB_MS + 1), true)
check('never approved, 12h after parking → not stale',
  isStaleJob(job({ status: 'awaiting-approval', lastActivity: parkedAt }), parkedAt + 12 * HOUR), false)

console.log('\nselectStaleJobs filters rather than throws')
const mixed = [
  job({ lastActivity: NOW - 30 * HOUR }),
  job({ lastActivity: NOW - MIN }),
  job({ status: 'completed', lastActivity: NOW - 30 * HOUR }),
]
check('1 of 3 selected', selectStaleJobs(mixed, NOW).length, 1)
check('empty list → empty', selectStaleJobs([], NOW).length, 0)

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
