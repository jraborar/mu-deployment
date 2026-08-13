import { type NextRequest } from 'next/server'
import { createJob, getJob, type Job } from '@/lib/jobStore'
import { executeJob } from '@/lib/deployer'
import { computeStages } from '@/lib/pipeline'

export const runtime = 'nodejs'

const INPUT_RE = /^[a-z0-9.\-_]+$/i

function streamJob(job: Job, request: NextRequest): Response {
  const stream = new ReadableStream({
    start(controller) {
      const send = (data: object) => {
        try {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`))
        } catch {}
      }

      // Send current job state first so any reconnecting window restores full UI
      send({
        type:            'job-meta',
        site:            job.site,
        site_name:       job.site_name ?? null,
        source:          job.source,
        destination:     job.destination,
        label:           job.label,
        stages:          job.stages,
        completedStages: job.completedStages,
        currentStage:    job.currentStage,
        status:          job.status,
      })

      for (const entry of job.logs) send(entry)

      if (['completed', 'failed', 'paused'].includes(job.status)) {
        send({ type: 'complete', status: job.status })
        controller.close()
        return
      }

      // Replay approval state on reconnect so UI shows buttons immediately
      if (job.status === 'awaiting-approval' && job.pendingApproval) {
        send({
          type:         'awaiting-approval',
          approvalType: job.pendingApproval.approvalType,
          message:      job.pendingApproval.message,
          nextStage:    job.pendingApproval.nextStage,
          diffStat:     job.pendingApproval.diffStat,
          approveLabel: job.pendingApproval.approveLabel,
          rejectLabel:  job.pendingApproval.rejectLabel,
        })
      }

      const onEvent = (data: object) => send(data)
      const onDone  = () => { try { controller.close() } catch {} }

      job.emitter.on('event', onEvent)
      job.emitter.once('done', onDone)

      const heartbeat = setInterval(() => send({ type: 'heartbeat' }), 5000)

      const cleanup = () => {
        clearInterval(heartbeat)
        job.emitter.off('event', onEvent)
        job.emitter.off('done', onDone)
      }

      request.signal.addEventListener('abort', cleanup)
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type':      'text/event-stream',
      'Cache-Control':     'no-cache',
      'Connection':        'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Job-Id':          job.id,
    },
  })
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null)
  if (!body) return Response.json({ error: 'Invalid JSON' }, { status: 400 })

  const { site, source, destination, label } = body as Record<string, string>

  if (!INPUT_RE.test(site) || !INPUT_RE.test(source)) {
    return Response.json({ error: 'Invalid site or source name' }, { status: 400 })
  }
  if (label && !INPUT_RE.test(label)) {
    return Response.json({ error: 'Invalid label' }, { status: 400 })
  }
  if (!['dev', 'test', 'live'].includes(destination)) {
    return Response.json({ error: 'Destination must be dev, test, or live' }, { status: 400 })
  }

  const stages = computeStages(source, destination)
  if (stages.length === 0) {
    return Response.json({ error: 'Destination must come after source in the pipeline (dev → test → live)' }, { status: 400 })
  }

  const job = createJob({ site, source, destination, stages, label: label || source })
  void executeJob(job)
  return streamJob(job, request)
}

export async function GET(request: NextRequest) {
  const url   = new URL(request.url)
  const jobId = url.searchParams.get('jobId')
  if (!jobId) return Response.json({ error: 'Missing jobId' }, { status: 400 })
  const job = getJob(jobId)
  if (!job) return Response.json({ error: 'Job not found' }, { status: 404 })
  return streamJob(job, request)
}
