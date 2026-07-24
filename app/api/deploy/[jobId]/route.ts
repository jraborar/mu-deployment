import { type NextRequest } from 'next/server'
import { getJob, type Job } from '@/lib/jobStore'

export const runtime = 'nodejs'

function streamJob(job: Job, request: NextRequest): Response {
  const stream = new ReadableStream({
    start(controller) {
      const send = (data: object) => {
        try {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`))
        } catch {}
      }

      // Always send job meta first so the client can restore pipeline state
      send({
        type: 'job-meta',
        site: job.site,
        source: job.source,
        destination: job.destination,
        stages: job.stages,
        completedStages: job.completedStages,
        currentStage: job.currentStage,
        status: job.status,
      })

      for (const entry of job.logs) send(entry)

      if (['completed', 'failed', 'paused'].includes(job.status)) {
        send({ type: 'complete', status: job.status })
        controller.close()
        return
      }

      // Restore approval prompt if job is waiting — replay the original payload
      if (job.status === 'awaiting-approval' && job.pendingApproval) {
        const { resolve: _r, ...payload } = job.pendingApproval
        send({ type: 'awaiting-approval', ...payload })
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

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params
  const job = getJob(jobId)
  if (!job) return Response.json({ error: 'Job not found' }, { status: 404 })
  return streamJob(job, request)
}
