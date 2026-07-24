import { type Job, type LogEntry } from '@/lib/jobStore'
import { run, getLatestCommitHash } from '@/lib/terminus'
import { findByPrefix } from '@/lib/pipeline'
import { createDeploymentRecord, finalizeDeploymentRecord } from '@/lib/supabase'
import { getPacificYYMMDD } from '@/lib/timezone'

class CancelledError extends Error {
  constructor() { super('Deployment cancelled by user') }
}

export function waitForApproval(
  job: Job,
  payload: { approvalType: string; message: string; nextStage?: string; diffStat?: string },
): Promise<boolean> {
  return new Promise((resolve) => {
    job.pendingApproval = { resolve, ...payload }
  })
}

function checkCancelled(job: Job): void {
  if (job.cancelRequested) throw new CancelledError()
}

export async function executeJob(job: Job): Promise<void> {
  const emit = (data: object) => {
    job.lastActivity = Date.now()
    job.emitter.emit('event', { ...data, ts: Date.now() })
  }

  const log = (logType: LogEntry['logType'], message: string) => {
    const entry: LogEntry = { type: 'log', logType, message, ts: Date.now() }
    job.logs.push(entry)
    job.lastActivity = Date.now()
    job.emitter.emit('event', entry)
  }

  // Write to history immediately so a server crash still leaves a trace
  await createDeploymentRecord(job.id, {
    site: job.site,
    source: job.source,
    destination: job.destination,
    status: 'running',
    started_at: new Date(job.startedAt).toISOString(),
  })

  try {
    log('info', `Deployment started: ${job.source} → ${job.destination} on ${job.site}${job.autoApprove ? ' (scheduled)' : ''}`)

    // 1. Validate site
    log('status', `Validating site ${job.site}...`)
    const siteInfo = await run(`terminus site:info ${job.site} 2>&1`)
    if (siteInfo.stdout.includes('not found') || siteInfo.code !== 0) {
      throw new Error(`Site "${job.site}" not found or inaccessible`)
    }
    log('info', `Site ${job.site} verified`)

    // 2. Check uncommitted changes
    log('status', 'Checking for uncommitted changes...')
    for (const env of ['dev', 'test', 'live']) {
      log('info', `  Checking ${env}...`)
      const diff = await run(`terminus env:diffstat ${job.site}.${env} 2>&1`)
      if (diff.stdout.includes('files changed') || diff.stdout.includes('ahead')) {
        throw new Error(`Uncommitted or undeployed code exists in ${env}. Commit and deploy before proceeding.`)
      }
    }
    log('info', 'No uncommitted changes detected')

    // 3. Validate source and check git alignment (custom multidevs only)
    const stdEnvs = ['dev', 'test', 'live']
    if (!stdEnvs.includes(job.source)) {
      log('status', `Validating multidev "${job.source}"...`)
      const multidevList = await run(`terminus multidev:list ${job.site} --field=id 2>&1`)
      if (!multidevList.stdout.toLowerCase().includes(job.source.toLowerCase())) {
        throw new Error(`Multidev "${job.source}" does not exist on site ${job.site}`)
      }

      log('status', `Checking code alignment between dev and ${job.source}...`)
      const gitUrlResult = await run(`terminus connection:info ${job.site}.dev --field=git_url 2>/dev/null`)
      const gitUrl = gitUrlResult.stdout.trim()

      if (gitUrl) {
        const safeSite = job.site.replace(/[^a-zA-Z0-9-]/g, '_')
        const tmpDir = `/tmp/mu_deploy_${safeSite}_${job.id}`
        await run(`rm -rf "${tmpDir}"`)
        log('info', 'Cloning repository for alignment check (may take a moment)...')
        await run(`git clone --bare --no-single-branch "${gitUrl}" "${tmpDir}" 2>/dev/null`)

        // Count commits in dev (master) that are NOT in source.
        // If 0, dev is not ahead — source may be ahead of dev, which is expected before deployment.
        const aheadResult = await run(`git -C "${tmpDir}" rev-list --count "${job.source}..master" 2>/dev/null`)
        const devAheadCount = parseInt(aheadResult.stdout.trim(), 10) || 0

        if (devAheadCount > 0) {
          const diffStatResult = await run(`git -C "${tmpDir}" diff --shortstat "${job.source}" master 2>/dev/null`)
          const diffStat = diffStatResult.stdout.trim()
          await run(`rm -rf "${tmpDir}"`)
          log('warn', `dev is ${devAheadCount} commit(s) ahead of ${job.source}: ${diffStat}`)

          if (job.autoApprove) {
            log('warn', `Scheduled run — skipping merge, proceeding`)
          } else {
            const alignPayload = {
              approvalType: 'alignment' as const,
              message: `dev is ${devAheadCount} commit(s) ahead of ${job.source} (${diffStat}). Merge dev into ${job.source} first?`,
              diffStat,
            }
            emit({ type: 'awaiting-approval', ...alignPayload })
            job.status = 'awaiting-approval'
            const shouldMerge = await waitForApproval(job, alignPayload)
            job.status = 'running'
            if (shouldMerge) {
              log('status', `Merging dev into ${job.source}...`)
              const r = await run(`terminus multidev:merge-from-dev --updatedb ${job.site}.${job.source} 2>&1`)
              log(r.code === 0 ? 'success' : 'error', `merge-from-dev: ${r.stdout.trim() || r.stderr.trim()}`)
            } else {
              log('warn', `Skipping merge — proceeding with unaligned branches`)
            }
          }
        } else {
          await run(`rm -rf "${tmpDir}"`)
          log('info', `dev is not ahead of ${job.source} — no merge needed`)
        }
      } else {
        log('warn', 'Could not retrieve git URL — skipping alignment check')
      }
    }

    // 4. Pending pipeline deploy check (informational only)
    if (job.stages.includes('test')) {
      const devHash = await getLatestCommitHash(job.site, 'dev')
      const testLog = await run(`terminus env:code-log ${job.site}.test --format=json 2>/dev/null`)
      if (devHash && !testLog.stdout.includes(devHash)) {
        log('warn', 'dev has commits not yet deployed to test')
      }
    }
    if (job.stages.includes('live')) {
      const testHash = await getLatestCommitHash(job.site, 'test')
      const liveLog  = await run(`terminus env:code-log ${job.site}.live --format=json 2>/dev/null`)
      if (testHash && !liveLog.stdout.includes(testHash)) {
        log('warn', 'test has commits not yet deployed to live')
      }
    }

    // 5. Stage loop
    const date = getPacificYYMMDD()
    const snapNames:    Record<string, string> = { dev: `snpd-${date}`, test: `snpt-${date}`, live: `snpl-${date}` }
    const snapPrefixes: Record<string, string> = { dev: 'snpd', test: 'snpt', live: 'snpl' }

    const multidevListResult = await run(`terminus multidev:list ${job.site} --field=id 2>&1`)
    const multidevList = multidevListResult.stdout

    for (let i = 0; i < job.stages.length; i++) {
      const stage     = job.stages[i]
      const nextStage = job.stages[i + 1] ?? null

      checkCancelled(job)
      job.currentStage = stage
      emit({ type: 'stage-start', stage })
      log('status', `Preparing ${stage} environment...`)

      const oldSnap = findByPrefix(multidevList, snapPrefixes[stage])
      if (oldSnap) {
        log('delete', `Removing old snapshot ${oldSnap}...`)
        await run(`terminus multidev:delete --yes ${job.site}.${oldSnap} 2>&1`)
        log('deleted', `Removed ${oldSnap}`)
      }

      log('create', `Creating snapshot ${snapNames[stage]}...`)
      const snapResult = await run(`terminus multidev:create ${job.site}.${stage} ${snapNames[stage]} 2>&1`)
      if (snapResult.code !== 0) throw new Error(`Snapshot creation failed: ${snapResult.stdout || snapResult.stderr}`)
      log('info', `Snapshot ${snapNames[stage]} created`)

      if (stage === 'dev') {
        log('status', `Merging ${job.source} into dev...`)
        const r = await run(`terminus multidev:merge-to-dev --updatedb ${job.site}.${job.source} 2>&1`)
        if (r.code !== 0) throw new Error(`Merge to dev failed: ${r.stdout || r.stderr}`)
      } else if (stage === 'test') {
        log('status', 'Deploying to test...')
        const r = await run(`terminus env:deploy --sync-content --updatedb --cc --note "Mu Deployment: ${job.source} to test" ${job.site}.test 2>&1`)
        if (r.code !== 0) throw new Error(`Deploy to test failed: ${r.stdout || r.stderr}`)
      } else if (stage === 'live') {
        log('status', 'Deploying to live...')
        const r = await run(`terminus env:deploy --updatedb --cc --note "Mu Deployment: ${job.source} to live" ${job.site}.live 2>&1`)
        if (r.code !== 0) throw new Error(`Deploy to live failed: ${r.stdout || r.stderr}`)
      }

      job.currentStage = null
      job.completedStages.push(stage)
      emit({ type: 'stage-complete', stage })
      log('success', `Successfully deployed to ${stage}`)

      if (nextStage) {
        if (job.autoApprove) {
          log('info', `Scheduled deployment — auto-approving to ${nextStage}`)
        } else {
          const stagePayload = {
            approvalType: 'stage' as const,
            nextStage,
            message: `Ready to deploy to ${nextStage}. Continue?`,
          }
          emit({ type: 'awaiting-approval', ...stagePayload })
          job.status = 'awaiting-approval'
          const approved = await waitForApproval(job, stagePayload)
          job.status = 'running'

          if (!approved) {
            job.status = 'paused'
            log('warn', `Paused after ${stage}. Re-run with source=${stage} and destination=${job.destination} to continue.`)
            emit({ type: 'complete', status: 'paused' })
            job.emitter.emit('done')
            await finalizeDeploymentRecord(job.id, {
              stages_completed: job.completedStages, status: 'paused',
              completed_at: new Date().toISOString(), logs: job.logs,
            })
            return
          }

          log('info', `Approved — continuing to ${nextStage}...`)
        }
      }
    }

    job.status = 'completed'
    log('success', `Deployment complete: ${job.source} → ${job.destination} on ${job.site}`)
    emit({ type: 'complete', status: 'completed' })
    job.emitter.emit('done')

    await finalizeDeploymentRecord(job.id, {
      stages_completed: job.completedStages, status: 'completed',
      completed_at: new Date().toISOString(), logs: job.logs,
    })
  } catch (err) {
    const isCancelled = err instanceof CancelledError
    const status = isCancelled ? 'cancelled' : 'failed'
    const message = isCancelled
      ? `Deployment cancelled after ${job.completedStages.length > 0 ? job.completedStages.join(', ') : 'start'}`
      : `Deployment failed: ${err instanceof Error ? err.message : String(err)}`

    const entry: LogEntry = { type: 'log', logType: isCancelled ? 'warn' : 'error', message, ts: Date.now() }
    job.logs.push(entry)
    job.emitter.emit('event', entry)
    emit({ type: 'complete', status })
    job.emitter.emit('done')

    await finalizeDeploymentRecord(job.id, {
      stages_completed: job.completedStages, status,
      completed_at: new Date().toISOString(), logs: job.logs,
    })
  }
}
