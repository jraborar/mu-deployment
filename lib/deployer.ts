import { type Job, type LogEntry } from '@/lib/jobStore'
import { run, runStream, getLatestCommitHash } from '@/lib/terminus'
import { findByPrefix } from '@/lib/pipeline'
import { createDeploymentRecord, finalizeDeploymentRecord, updateDeploymentSiteName } from '@/lib/supabase'
import { getPacificYYMMDD } from '@/lib/timezone'
import {
  broadcastMessage,
  startDeploymentThread,
  postThreadStep,
  postThreadBlocks,
  buildApprovalBlocks,
  buildCompleteBlocks,
  buildFailedBlocks,
  buildPausedBlocks,
  buildLongRunningBlocks,
} from '@/lib/slack'

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

  let siteLabel     = job.site
  let slackThreadTs: string | null = null
  const startedAt   = Date.now()

  const postStep = (message: string) => { void postThreadStep(slackThreadTs, message) }

  let longRunningTimer: ReturnType<typeof setTimeout> | null = null
  let longRunningInterval: ReturnType<typeof setInterval> | null = null

  const stopLongRunningAlerts = () => {
    if (longRunningTimer)   clearTimeout(longRunningTimer)
    if (longRunningInterval) clearInterval(longRunningInterval)
  }

  const sendProgressAlert = () => {
    if (!['running', 'awaiting-approval'].includes(job.status)) return
    const elapsedMin = Math.floor((Date.now() - startedAt) / 60000)
    const blocks = buildLongRunningBlocks(job.source, job.destination, siteLabel, elapsedMin, job.completedStages.length, job.stages.length, job.currentStage, job.site)
    const text   = `⏱ Deployment still running after ${elapsedMin} min on ${siteLabel}`
    if (slackThreadTs) {
      void postThreadBlocks(slackThreadTs, blocks, text)
    } else {
      void broadcastMessage(blocks, text)
    }
  }

  longRunningTimer = setTimeout(() => {
    sendProgressAlert()
    longRunningInterval = setInterval(sendProgressAlert, 10 * 60 * 1000)
  }, 30 * 60 * 1000)

  try {
    log('info', `Deployment started: ${job.source} → ${job.destination} on ${job.site}${job.autoApprove ? ' (scheduled)' : ''}`)

    // 1. Verify Terminus authentication
    log('status', 'Verifying Terminus authentication...')
    const token = process.env.TERMINUS_TOKEN
    if (token) {
      await run(`terminus auth:login --machine-token="${token}" 2>&1`)
    }
    const whoami = await run(`terminus auth:whoami 2>&1`)
    const identity = whoami.stdout.split('\n').find(l => l.includes('@'))?.trim()
    if (whoami.code !== 0 || !identity) {
      throw new Error('Terminus is not authenticated. Check TERMINUS_TOKEN environment variable.')
    }
    log('info', `Authenticated as: ${identity}`)
    postStep(`✓ Authenticated as ${identity}`)

    // 2. Validate site and resolve human-readable label for notifications
    log('status', `Validating site ${job.site}...`)
    const siteInfo = await run(`terminus site:info ${job.site} 2>&1`)
    if (siteInfo.stdout.includes('not found') || siteInfo.code !== 0) {
      throw new Error(`Site "${job.site}" not found or inaccessible`)
    }
    const cleanedInfo = siteInfo.stdout.split('\n').filter(l => !/^\s*(Deprecated|Warning|Notice|PHP):/i.test(l)).join('\n').trim()
    const jsonStart = cleanedInfo.search(/[{[]/)
    if (jsonStart !== -1) {
      try { const d = JSON.parse(cleanedInfo.slice(jsonStart)); siteLabel = d?.label ?? d?.name ?? job.site } catch {}
    }
    log('info', `Site ${siteLabel} verified`)
    if (siteLabel !== job.site) {
      job.site_name = siteLabel
      void updateDeploymentSiteName(job.id, siteLabel)
    }
    slackThreadTs = await startDeploymentThread(job.source, job.destination, siteLabel, job.site)

    // 3. Check uncommitted changes via JSON (structured, not fragile string matching)
    log('status', 'Checking for uncommitted changes...')
    for (const env of ['dev', 'test', 'live']) {
      log('info', `  Checking ${env}...`)
      const diff = await run(`terminus env:diffstat ${job.site}.${env} --format=json 2>&1`)
      let hasChanges = false
      try {
        const cleaned = diff.stdout.split('\n')
          .filter(l => !/^\s*(Deprecated|Warning|Notice|PHP):/i.test(l))
          .join('\n').trim()
        const data = JSON.parse(cleaned)
        hasChanges = Array.isArray(data) && data.length > 0
      } catch {
        hasChanges = diff.stdout.includes('files changed') || diff.stdout.includes('ahead')
      }
      if (hasChanges) {
        throw new Error(`Uncommitted or undeployed code exists in ${env}. Commit and deploy before proceeding.`)
      }
    }
    log('info', 'No uncommitted changes detected')
    postStep('✓ No uncommitted changes in dev / test / live')

    // 3. Validate source and check git alignment (custom multidevs only)
    const stdEnvs = ['dev', 'test', 'live']
    if (!stdEnvs.includes(job.source)) {
      log('status', `Validating multidev "${job.source}"...`)
      const multidevList = await run(`terminus multidev:list ${job.site} --field=id 2>&1`)
      if (!multidevList.stdout.toLowerCase().includes(job.source.toLowerCase())) {
        throw new Error(`Multidev "${job.source}" does not exist on site ${job.site}`)
      }

      log('status', `Checking code alignment between dev and ${job.source}...`)
      const devHash = await getLatestCommitHash(job.site, 'dev')
      if (!devHash) {
        log('warn', 'Could not retrieve dev commit hash — skipping alignment check')
      } else {
        const sourceLogResult = await run(`terminus env:code-log ${job.site}.${job.source} --field=hash 2>/dev/null`)
        const devAhead = !sourceLogResult.stdout.includes(devHash)

        if (devAhead) {
          log('warn', `Master is ahead of ${job.source} — awaiting decision before snapshot`)
          const alignPayload = {
            approvalType: 'alignment' as const,
            message: `Master went ahead of \`${job.source}\` on \`${siteLabel}\`. Would you like to merge or cancel?`,
          }
          emit({ type: 'awaiting-approval', ...alignPayload })
          job.status = 'awaiting-approval'
          void postThreadBlocks(
            slackThreadTs,
            buildApprovalBlocks(
              job.id,
              `Master went ahead of \`${job.source}\` on \`${siteLabel}\`. Would you like to merge or cancel?`,
              'Merge',
              'Cancel',
            ),
            `Master went ahead of ${job.source} on ${siteLabel}`,
          )
          const shouldMerge = await waitForApproval(job, alignPayload)
          job.status = 'running'

          if (shouldMerge) {
            log('status', `Merging dev into ${job.source}...`)
            postStep(`↙ Merging dev → \`${job.source}\`...`)
            const r = await run(`terminus multidev:merge-from-dev --updatedb ${job.site}.${job.source} 2>&1`)
            if (r.code !== 0) throw new Error(`Failed to merge dev into ${job.source}: ${r.stdout.trim() || r.stderr.trim()}`)
            log('success', `Merged dev into ${job.source}`)
            postStep(`✓ Merged dev into \`${job.source}\``)
          } else {
            throw new CancelledError()
          }
        } else {
          log('info', `dev is aligned with ${job.source} — no merge needed`)
        }
      }
    }

    // 4. Pending pipeline deploy check (informational only)
    if (job.stages.includes('test')) {
      const devHash = await getLatestCommitHash(job.site, 'dev')
      const testLog = await run(`terminus env:code-log ${job.site}.test --field=hash 2>/dev/null`)
      if (devHash && !testLog.stdout.includes(devHash)) {
        log('warn', 'dev has commits not yet deployed to test')
      }
    }
    if (job.stages.includes('live')) {
      const testHash = await getLatestCommitHash(job.site, 'test')
      const liveLog  = await run(`terminus env:code-log ${job.site}.live --field=hash 2>/dev/null`)
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
        postStep(`🗑 Removing old snapshot \`${oldSnap}\`...`)
        await run(`terminus multidev:delete --yes ${job.site}.${oldSnap} 2>&1`)
        log('deleted', `Removed ${oldSnap}`)
        postStep(`✓ Removed \`${oldSnap}\``)
      }

      log('create', `Creating snapshot ${snapNames[stage]}...`)
      postStep(`◈ Creating snapshot \`${snapNames[stage]}\`... _(this is the longest step — typically 30–45 min)_`)
      const snapResult = await runStream(
        `terminus multidev:create ${job.site}.${stage} ${snapNames[stage]} 2>&1`,
        (line) => log('info', line),
      )
      if (snapResult.code !== 0) throw new Error(`Snapshot creation failed`)
      log('info', `Snapshot ${snapNames[stage]} created`)
      postStep(`✓ Snapshot \`${snapNames[stage]}\` created`)

      checkCancelled(job)

      if (stage === 'dev') {
        log('status', `Merging ${job.source} into dev...`)
        postStep(`◈ Merging \`${job.source}\` → dev...`)
        const r = await runStream(
          `terminus multidev:merge-to-dev --updatedb ${job.site}.${job.source} 2>&1`,
          (line) => log('info', line),
        )
        if (r.code !== 0) throw new Error(`Merge to dev failed`)
        postStep(`✓ Merged to dev`)
      } else if (stage === 'test') {
        log('status', 'Deploying to test...')
        postStep(`◈ Deploying to test...`)
        const r = await runStream(
          `terminus env:deploy --sync-content --updatedb --cc --note "Pantheon Managed Updates: Deployed from ${job.label}" ${job.site}.test 2>&1`,
          (line) => log('info', line),
        )
        if (r.code !== 0) throw new Error(`Deploy to test failed`)
        postStep(`✓ Deployed to test`)
      } else if (stage === 'live') {
        log('status', 'Deploying to live...')
        postStep(`◈ Deploying to live...`)
        const r = await runStream(
          `terminus env:deploy --updatedb --cc --note "Pantheon Managed Updates: Deployed from ${job.label}" ${job.site}.live 2>&1`,
          (line) => log('info', line),
        )
        if (r.code !== 0) throw new Error(`Deploy to live failed`)
        postStep(`✓ Deployed to live`)
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
          void broadcastMessage(
            buildApprovalBlocks(
              job.id,
              `\`${job.source}\` deployed to \`${stage}\` on \`${siteLabel}\`. Ready to continue to \`${nextStage}\`?`,
              `✓ Deploy to ${nextStage}`,
              '⏸ Pause here',
            ),
            `Approval needed: deploy to ${nextStage} on ${siteLabel}`,
          )
          const approved = await waitForApproval(job, stagePayload)
          job.status = 'running'

          if (!approved) {
            job.status = 'paused'
            log('warn', `Paused after ${stage}. Re-run with source=${stage} and destination=${job.destination} to continue.`)
            emit({ type: 'complete', status: 'paused' })
            job.emitter.emit('done')
            void broadcastMessage(
              buildPausedBlocks(job.source, job.destination, siteLabel, stage, job.site),
              `Deployment paused after ${stage} on ${siteLabel}`,
            )
            await finalizeDeploymentRecord(job.id, {
              stages_completed: job.completedStages, status: 'paused',
              completed_at: new Date().toISOString(), logs: job.logs, site_name: siteLabel !== job.site ? siteLabel : undefined,
            })
            return
          }

          log('info', `Approved — continuing to ${nextStage}...`)
        }
      }
    }

    job.status = 'completed'
    const elapsedMin = Math.round((Date.now() - startedAt) / 60000)
    log('success', `Deployment complete: ${job.source} → ${job.destination} on ${siteLabel}`)
    emit({ type: 'complete', status: 'completed' })
    job.emitter.emit('done')
    postStep(`✅ *All done* — ${job.completedStages.join(' → ')} completed in ${elapsedMin} min`)
    void broadcastMessage(
      buildCompleteBlocks(job.source, job.destination, siteLabel, job.completedStages, job.site),
      `Deployment complete: ${job.source} → ${job.destination} on ${siteLabel}`,
    )

    await finalizeDeploymentRecord(job.id, {
      stages_completed: job.completedStages, status: 'completed',
      completed_at: new Date().toISOString(), logs: job.logs, site_name: siteLabel !== job.site ? siteLabel : undefined,
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
    if (!isCancelled) {
      postStep(`❌ *Failed:* ${err instanceof Error ? err.message : String(err)}`)
      void broadcastMessage(
        buildFailedBlocks(job.source, job.destination, siteLabel, err instanceof Error ? err.message : String(err), job.site),
        `Deployment failed: ${job.source} → ${job.destination} on ${siteLabel}`,
      )
    }

    await finalizeDeploymentRecord(job.id, {
      stages_completed: job.completedStages, status,
      completed_at: new Date().toISOString(), logs: job.logs, site_name: siteLabel !== job.site ? siteLabel : undefined,
    })
  } finally {
    stopLongRunningAlerts()
  }
}
