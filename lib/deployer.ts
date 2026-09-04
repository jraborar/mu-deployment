import { type Job, type LogEntry } from '@/lib/jobStore'
import { run, runStream, getLatestCommitHash } from '@/lib/terminus'
import { findByPrefix } from '@/lib/pipeline'
import { createDeploymentRecord, finalizeDeploymentRecord, updateDeploymentSiteName } from '@/lib/supabase'
import { updateSite } from '@/lib/sites'
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
  buildCancelledBlocks,
  buildLongRunningBlocks,
} from '@/lib/slack'

class CancelledError extends Error {
  constructor() { super('Deployment cancelled by user') }
}

class PauseError extends Error {
  constructor() { super('Deployment paused by user') }
}

export function waitForApproval(
  job: Job,
  payload: { approvalType: string; message: string; nextStage?: string; diffStat?: string; approveLabel?: string; rejectLabel?: string },
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

  let stageStartedAt: number | null = null

  const sendProgressAlert = () => {
    if (!['running', 'awaiting-approval'].includes(job.status)) return
    const elapsedMin      = Math.floor((Date.now() - startedAt) / 60000)
    const stageElapsedMin = stageStartedAt ? Math.floor((Date.now() - stageStartedAt) / 60000) : null
    const blocks = buildLongRunningBlocks(job.source, job.destination, siteLabel, elapsedMin, job.completedStages.length, job.stages.length, job.currentStage, stageElapsedMin, job.site)
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
    checkCancelled(job)
    log('status', 'Verifying Terminus authentication...')
    const token = process.env.TERMINUS_TOKEN
    if (token) {
      await run(`terminus auth:login --machine-token="${token}" 2>&1`, job)
    }
    const whoami = await run(`terminus auth:whoami 2>&1`, job)
    const identity = whoami.stdout.split('\n').find(l => l.includes('@'))?.trim()
    if (whoami.code !== 0 || !identity) {
      throw new Error('Terminus is not authenticated. Check TERMINUS_TOKEN environment variable.')
    }
    log('info', `Authenticated as: ${identity}`)
    postStep(`✓ Authenticated as ${identity}`)

    // 2. Validate site and resolve human-readable label for notifications
    checkCancelled(job)
    log('status', `Validating site ${job.site}...`)
    const siteInfo = await run(`terminus site:info ${job.site} 2>&1`, job)
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

    // Helper: prompt via thread + UI, wait for decision, honour cancel
    const prompt = async (
      approvalType: 'alignment' | 'stage',
      message: string,
      approveLabel: string,
      rejectLabel: string,
      slackMessage: string,
    ): Promise<boolean> => {
      const payload = { approvalType, message, approveLabel, rejectLabel }
      emit({ type: 'awaiting-approval', ...payload })
      job.status = 'awaiting-approval'
      void postThreadBlocks(
        slackThreadTs,
        buildApprovalBlocks(job.id, message, approveLabel, rejectLabel),
        slackMessage,
      )
      const approved = await waitForApproval(job, payload)
      job.status = 'running'
      checkCancelled(job)
      return approved
    }

    // Helper: pause the job cleanly (used when user picks Pause on any pre-check)
    const pauseHere = async (reason: string) => {
      job.status = 'paused'
      log('warn', `Deployment paused — ${reason}`)
      emit({ type: 'complete', status: 'paused' })
      job.emitter.emit('done')
      void postThreadBlocks(
        slackThreadTs,
        buildPausedBlocks(job.source, job.destination, siteLabel, 'pre-checks', job.site),
        `Deployment paused on ${siteLabel} — ${reason}`,
      )
      await finalizeDeploymentRecord(job.id, {
        stages_completed: job.completedStages, status: 'paused',
        completed_at: new Date().toISOString(), logs: job.logs,
        site_name: siteLabel !== job.site ? siteLabel : undefined,
      })
      throw new PauseError()
    }

    // 3. Check dev connection mode — if SFTP, offer to switch to git or pause
    checkCancelled(job)
    log('status', 'Checking dev connection mode...')
    const connModeResult = await run(`terminus env:info ${job.site}.dev --field=connection_mode 2>/dev/null`, job)
    const connMode = connModeResult.stdout.split('\n').map(l => l.trim()).find(l => /^(git|sftp)$/i.test(l))?.toLowerCase()
    if (!connMode) {
      log('warn', 'Could not determine dev connection mode — skipping check')
    } else if (connMode === 'sftp') {
      log('warn', 'Dev is in SFTP mode — prompting')
      const shouldSwitch = await prompt(
        'alignment',
        `Dev is in SFTP mode on \`${siteLabel}\`. Switch to git mode (uncommitted SFTP changes will be lost) or pause to commit first?`,
        'Switch to git',
        'Pause',
        `Dev in SFTP mode on ${siteLabel}`,
      )
      if (shouldSwitch) {
        log('status', 'Switching dev to git mode...')
        const r = await run(`terminus connection:set ${job.site}.dev git 2>&1`, job)
        if (r.code !== 0) throw new Error(`Failed to switch dev to git mode: ${r.stdout.trim()}`)
        log('success', 'Dev switched to git mode')
        postStep('✓ Dev switched to git mode')
      } else {
        await pauseHere('dev is in SFTP mode — switch to git and commit before resuming')
      }
    }
    log('info', `Dev connection mode: ${connMode ?? 'unknown'} ✓`)
    postStep(`✓ Dev is in ${connMode ?? 'git'} mode`)

    // 4. Check uncommitted changes — offer to pause or stop per environment
    checkCancelled(job)
    log('status', 'Checking for uncommitted changes...')
    for (const env of ['dev', 'test', 'live']) {
      log('info', `  Checking ${env}...`)
      const diff = await run(`terminus env:diffstat ${job.site}.${env} --format=json 2>&1`, job)
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
        log('warn', `Uncommitted changes detected in ${env} — prompting`)
        const shouldPause = await prompt(
          'alignment',
          `\`${env}\` has uncommitted changes on \`${siteLabel}\`. Pause to commit and resolve, or stop the deployment?`,
          'Pause',
          'Stop',
          `Uncommitted changes in ${env} on ${siteLabel}`,
        )
        if (shouldPause) {
          await pauseHere(`${env} has uncommitted changes — commit and resume when ready`)
        } else {
          throw new CancelledError()
        }
      }
    }
    log('info', 'No uncommitted changes detected')
    postStep('✓ No uncommitted changes in dev / test / live')

    // 5. Validate source and check git alignment (custom multidevs only)
    const stdEnvs = ['dev', 'test', 'live']
    if (!stdEnvs.includes(job.source)) {
      checkCancelled(job)
      log('status', `Validating multidev "${job.source}"...`)
      const multidevList = await run(`terminus multidev:list ${job.site} --field=id 2>&1`, job)
      if (!multidevList.stdout.toLowerCase().includes(job.source.toLowerCase())) {
        throw new Error(`Multidev "${job.source}" does not exist on site ${job.site}`)
      }

      checkCancelled(job)
      log('status', `Checking code alignment between dev and ${job.source}...`)
      const devHash = await getLatestCommitHash(job.site, 'dev')
      if (!devHash) {
        log('warn', 'Could not retrieve dev commit hash — skipping alignment check')
      } else {
        const sourceLogResult = await run(`terminus env:code-log ${job.site}.${job.source} --field=hash 2>/dev/null`, job)
        const devAhead = !sourceLogResult.stdout.includes(devHash)

        if (devAhead) {
          log('warn', `Master is ahead of ${job.source} — awaiting decision before snapshot`)
          const shouldMerge = await prompt(
            'alignment',
            `Master went ahead of \`${job.source}\` on \`${siteLabel}\`. Would you like to merge or cancel?`,
            'Merge',
            'Cancel',
            `Master went ahead of ${job.source} on ${siteLabel}`,
          )
          if (shouldMerge) {
            log('status', `Merging dev into ${job.source}...`)
            postStep(`↙ Merging dev → \`${job.source}\`...`)
            const mergeLines: string[] = []
            const r = await runStream(
              `terminus multidev:merge-from-dev --updatedb ${job.site}.${job.source} 2>&1`,
              (line) => { log('info', line); mergeLines.push(line) },
              job,
            )
            checkCancelled(job)
            if (r.code !== 0) throw new Error(`Failed to merge dev into ${job.source}: ${mergeLines.slice(-3).join(' ')}`)
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

    // 6. Pipeline alignment WARNINGS.
    //
    // These exist to catch code already sitting in the pipeline that this deploy
    // would sweep along with it. They must never deploy anything themselves.
    //
    // They used to offer "Deploy test→live now" and run `env:deploy` right here —
    // before the stage loop below, which is where the snapshot is taken and where
    // the approval gate lives. So a test→live job hit LIVE with no snapshot and no
    // gate. Worse, it fired on every such job by design: "test has code not yet in
    // live" is exactly what a test→live deploy is FOR.
    //
    // So a gap is only worth mentioning when this job will pass THROUGH that
    // environment on its way somewhere else — then its existing code really does
    // get carried along. A gap at the job's own entry point is just the work.
    checkCancelled(job)
    const entryStage = job.stages[0] ?? null

    if (job.stages.includes('test') && entryStage !== 'test') {
      const devHash = await getLatestCommitHash(job.site, 'dev')
      const testLog = await run(`terminus env:code-log ${job.site}.test --field=hash 2>/dev/null`, job)
      if (devHash && !testLog.stdout.includes(devHash)) {
        log('warn', 'dev has commits not yet deployed to test — they will be carried along by this deploy')
        const proceed = await prompt(
          'alignment',
          `Dev has code not yet deployed to test on \`${siteLabel}\`. This deploy will carry it along. Continue, or pause?`,
          'Continue',
          'Pause',
          `Dev has undeployed code on ${siteLabel} — it will be carried along`,
        )
        if (!proceed) await pauseHere('dev has undeployed code — review it, then re-run')
      }
    }

    if (job.stages.includes('live') && entryStage !== 'live') {
      const testHash = await getLatestCommitHash(job.site, 'test')
      const liveLog  = await run(`terminus env:code-log ${job.site}.live --field=hash 2>/dev/null`, job)
      if (testHash && !liveLog.stdout.includes(testHash)) {
        log('warn', 'test has commits not yet deployed to live — they will be carried along by this deploy')
        const proceed = await prompt(
          'alignment',
          `Test has code not yet deployed to live on \`${siteLabel}\`. This deploy will carry it along. Continue, or pause?`,
          'Continue',
          'Pause',
          `Test has undeployed code on ${siteLabel} — it will be carried along`,
        )
        if (!proceed) await pauseHere('test has undeployed code — review it, then re-run')
      }
    }

    // 6. Stage loop
    const date = getPacificYYMMDD()
    const snapNames:    Record<string, string> = { dev: `snpd-${date}`, test: `snpt-${date}`, live: `snpl-${date}` }
    const snapPrefixes: Record<string, string> = { dev: 'snpd', test: 'snpt', live: 'snpl' }

    const multidevListResult = await run(`terminus multidev:list ${job.site} --field=id 2>&1`, job)
    const multidevList = multidevListResult.stdout

    for (let i = 0; i < job.stages.length; i++) {
      const stage = job.stages[i]

      checkCancelled(job)

      // Approval happens BEFORE the environment is touched, not between stages.
      // The old gate only fired when a nextStage existed, so a single-stage job —
      // exactly the test→live case a consultant runs after test is signed off —
      // got no gate at all. For a multi-stage job this is the same set of gates in
      // the same places: one before test, one before live.
      if (!job.autoApprove && stage !== 'dev') {
        const gate = {
          approvalType: 'stage' as const,
          nextStage: stage,
          message: `Ready to deploy to ${stage}. Continue?`,
        }
        emit({ type: 'awaiting-approval', ...gate })
        job.status = 'awaiting-approval'
        void postThreadBlocks(
          slackThreadTs,
          buildApprovalBlocks(
            job.id,
            `Ready to deploy \`${job.source}\` to \`${stage}\` on \`${siteLabel}\`. A snapshot is taken first.`,
            `✓ Deploy to ${stage}`,
            '⏸ Pause here',
          ),
          `Approval needed: deploy to ${stage} on ${siteLabel}`,
        )
        const approved = await waitForApproval(job, gate)
        job.status = 'running'
        if (!approved) {
          job.status = 'paused'
          const at = job.completedStages[job.completedStages.length - 1] ?? job.source
          log('warn', `Paused before ${stage}. Re-run with destination=${job.destination} when ready.`)
          emit({ type: 'complete', status: 'paused' })
          job.emitter.emit('done')
          void postThreadBlocks(
            slackThreadTs,
            buildPausedBlocks(job.source, job.destination, siteLabel, at, job.site),
            `Deployment paused before ${stage} on ${siteLabel}`,
          )
          await finalizeDeploymentRecord(job.id, {
            stages_completed: job.completedStages, status: 'paused',
            completed_at: new Date().toISOString(), logs: job.logs,
            site_name: siteLabel !== job.site ? siteLabel : undefined,
          })
          return
        }
        log('info', `Approved — deploying to ${stage}...`)
      }

      job.currentStage = stage
      stageStartedAt = Date.now()
      emit({ type: 'stage-start', stage })
      log('status', `Preparing ${stage} environment...`)

      const oldSnap = findByPrefix(multidevList, snapPrefixes[stage])
      if (oldSnap) {
        log('delete', `Removing old snapshot ${oldSnap}...`)
        postStep(`🗑 Removing old snapshot \`${oldSnap}\`...`)
        await run(`terminus multidev:delete --yes ${job.site}.${oldSnap} 2>&1`, job)
        log('deleted', `Removed ${oldSnap}`)
        postStep(`✓ Removed \`${oldSnap}\``)
      }

      log('create', `Creating snapshot ${snapNames[stage]}...`)
      postStep(`◈ Creating snapshot \`${snapNames[stage]}\`... _(this is the longest step — typically 30–45 min)_`)
      const snapResult = await runStream(
        `terminus multidev:create ${job.site}.${stage} ${snapNames[stage]} 2>&1`,
        (line) => log('info', line),
        job,
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
          job,
        )
        if (r.code !== 0) throw new Error(`Merge to dev failed`)
        postStep(`✓ Merged to dev`)
      } else if (stage === 'test') {
        log('status', 'Deploying to test...')
        postStep(`◈ Deploying to test...`)
        const r = await runStream(
          `terminus env:deploy --sync-content --updatedb --cc --note "Pantheon Managed Updates: Deployed from ${job.label}" ${job.site}.test 2>&1`,
          (line) => log('info', line),
          job,
        )
        if (r.code !== 0) throw new Error(`Deploy to test failed`)
        postStep(`✓ Deployed to test`)
      } else if (stage === 'live') {
        log('status', 'Deploying to live...')
        postStep(`◈ Deploying to live...`)
        const r = await runStream(
          `terminus env:deploy --updatedb --cc --note "Pantheon Managed Updates: Deployed from ${job.label}" ${job.site}.live 2>&1`,
          (line) => log('info', line),
          job,
        )
        if (r.code !== 0) throw new Error(`Deploy to live failed`)
        postStep(`✓ Deployed to live`)
      }

      job.currentStage = null
      job.completedStages.push(stage)
      emit({ type: 'stage-complete', stage })
      log('success', `Successfully deployed to ${stage}`)

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

    // Advance the staging cadence anchor — ONLY for managed staging-cycle deploys
    // (anchor_advance was stamped by mu-staging's prebook; false for fast-track,
    // absent for manual/ad-hoc deploys). Best-effort; never blocks the deploy.
    if (job.anchorAdvance) {
      await updateSite(job.site, { last_deployment: new Date().toISOString() }).catch(() => {})
    }
  } catch (err) {
    const isCancelled = err instanceof CancelledError
    const isPaused    = err instanceof PauseError
    if (isPaused) {
      // pauseHere() already finalized the record and emitted done — nothing more to do
      return
    }
    const status = isCancelled ? 'cancelled' : 'failed'
    const message = isCancelled
      ? `Deployment cancelled after ${job.completedStages.length > 0 ? job.completedStages.join(', ') : 'start'}`
      : `Deployment failed: ${err instanceof Error ? err.message : String(err)}`

    const entry: LogEntry = { type: 'log', logType: isCancelled ? 'warn' : 'error', message, ts: Date.now() }
    job.logs.push(entry)
    job.emitter.emit('event', entry)
    emit({ type: 'complete', status })
    job.emitter.emit('done')

    if (isCancelled) {
      const reason = job.autoApprove
        ? 'Cancelled by operator — reschedule if needed'
        : 'Cancelled by user'
      void postThreadBlocks(
        slackThreadTs,
        buildCancelledBlocks(job.source, job.destination, siteLabel, reason, job.completedStages, job.autoApprove, job.site),
        `Deployment cancelled on ${siteLabel}`,
      )
    } else {
      postStep(`❌ *Failed:* ${err instanceof Error ? err.message : String(err)}`)
      void postThreadBlocks(
        slackThreadTs,
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
