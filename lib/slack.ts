import { createHmac, timingSafeEqual } from 'crypto'
import { WebClient, type Block, type KnownBlock } from '@slack/web-api'

// ── Slack (Web API + Socket Mode) ─────────────────────────────────────────────

const SLACK_BOT_TOKEN   = process.env.SLACK_BOT_TOKEN   ?? ''
const SLACK_CHANNEL_ID  = process.env.SLACK_CHANNEL_ID  ?? ''
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL ?? ''

export function isSlackConfigured(): boolean {
  return Boolean((SLACK_BOT_TOKEN && SLACK_CHANNEL_ID) || SLACK_WEBHOOK_URL)
}

let _web: WebClient | null = null
function getWeb(): WebClient | null {
  if (!SLACK_BOT_TOKEN) return null
  if (!_web) _web = new WebClient(SLACK_BOT_TOKEN)
  return _web
}

const PANTHEON_ICON = 'https://avatars.githubusercontent.com/u/1043537'
const BOT_NAME      = 'Pantheon MU Deployment'

async function postSlackMessage(blocks: (Block | KnownBlock)[], text: string): Promise<void> {
  // Prefer Bot Token + Channel ID; fall back to incoming webhook
  const web = getWeb()
  if (web && SLACK_CHANNEL_ID) {
    try {
      await web.chat.postMessage({
        channel: SLACK_CHANNEL_ID, text, blocks,
        username: BOT_NAME, icon_url: PANTHEON_ICON,
      })
    } catch (err) {
      console.error('[slack] postMessage (web api) failed:', err)
    }
    return
  }
  if (SLACK_WEBHOOK_URL) {
    try {
      const res = await fetch(SLACK_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, blocks, username: BOT_NAME, icon_url: PANTHEON_ICON }),
      })
      if (!res.ok) console.error('[slack] postMessage (webhook) failed:', res.status, await res.text())
    } catch (err) {
      console.error('[slack] postMessage (webhook) failed:', err)
    }
  }
}

// ── Pumble (Incoming Webhook) ─────────────────────────────────────────────────

const PUMBLE_WEBHOOK_URL = process.env.PUMBLE_WEBHOOK_URL ?? ''

export function isPumbleConfigured(): boolean {
  return Boolean(PUMBLE_WEBHOOK_URL)
}

async function postPumbleMessage(blocks: (Block | KnownBlock)[], text: string): Promise<void> {
  try {
    const res = await fetch(PUMBLE_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, blocks, username: BOT_NAME, icon_url: PANTHEON_ICON }),
    })
    if (!res.ok) console.error('[pumble] postMessage failed:', res.status, await res.text())
  } catch (err) {
    console.error('[pumble] postMessage failed:', err)
  }
}

// ── Thread support ────────────────────────────────────────────────────────────

// Posts the deployment started message to Slack and returns its ts for threading.
// Also broadcasts to Pumble (no threading needed there).
export async function startDeploymentThread(
  source: string, destination: string, site: string, siteId?: string
): Promise<string | null> {
  const text   = `🚀 Deployment started: ${source} → ${destination} on ${site}`
  const blocks = buildStartedBlocks(source, destination, site, siteId)
  void postPumbleMessage(blocks, text)
  const web = getWeb()
  if (web && SLACK_CHANNEL_ID) {
    try {
      const result = await web.chat.postMessage({
        channel: SLACK_CHANNEL_ID, text, blocks,
        username: BOT_NAME, icon_url: PANTHEON_ICON,
      })
      return (result.ts as string) ?? null
    } catch (err) { console.error('[slack] startDeploymentThread failed:', err) }
  } else if (SLACK_WEBHOOK_URL) {
    void postSlackMessage(blocks, text)
  }
  return null
}

// Posts rich blocks as a thread reply. Falls back silently if no thread ts or Web API unavailable.
export async function postThreadBlocks(threadTs: string | null, blocks: (Block | KnownBlock)[], text: string): Promise<void> {
  if (!threadTs) return
  const web = getWeb()
  if (!web || !SLACK_CHANNEL_ID) return
  try {
    await web.chat.postMessage({
      channel: SLACK_CHANNEL_ID, thread_ts: threadTs, text, blocks,
      username: BOT_NAME, icon_url: PANTHEON_ICON,
    })
  } catch (err) { console.error('[slack] postThreadBlocks failed:', err) }
}

// Posts a step update as a thread reply on the deployment started message.
export async function postThreadStep(threadTs: string | null, message: string): Promise<void> {
  if (!threadTs) return
  const web = getWeb()
  if (!web || !SLACK_CHANNEL_ID) return
  try {
    await web.chat.postMessage({
      channel: SLACK_CHANNEL_ID,
      thread_ts: threadTs,
      text: message,
      username: BOT_NAME,
      icon_url: PANTHEON_ICON,
    })
  } catch (err) { console.error('[slack] postThreadStep failed:', err) }
}

// ── Broadcast to all configured platforms ─────────────────────────────────────

export async function broadcastMessage(blocks: (Block | KnownBlock)[], text: string): Promise<void> {
  await Promise.all([
    isSlackConfigured()  ? postSlackMessage(blocks, text)  : Promise.resolve(),
    isPumbleConfigured() ? postPumbleMessage(blocks, text) : Promise.resolve(),
  ])
}

// ── Signature verification (shared format — Slack and Pumble both use HMAC-SHA256) ──

export function verifySignature(rawBody: string, timestamp: string, signature: string, secret: string): boolean {
  if (!secret) return false
  const age = Math.abs(Date.now() / 1000 - Number(timestamp))
  if (age > 300) return false // reject replays older than 5 minutes
  const hmac    = createHmac('sha256', secret).update(`v0:${timestamp}:${rawBody}`).digest('hex')
  const computed = Buffer.from(`v0=${hmac}`)
  const received = Buffer.from(signature)
  if (computed.length !== received.length) return false
  return timingSafeEqual(computed, received)
}

// ── Block Kit builders (compatible with both Slack and Pumble) ────────────────

// When siteId is provided and differs from the display name, renders both:
//   "Site Name (`site-id`)"
// Otherwise just wraps the name in backticks.
function formatSite(name: string, siteId?: string): string {
  return siteId && siteId !== name ? `${name} (\`${siteId}\`)` : `\`${name}\``
}

export function buildLongRunningBlocks(
  source: string, destination: string, site: string,
  elapsedMin: number, done: number, total: number, currentStage: string | null,
  stageElapsedMin: number | null,
  siteId?: string,
): (Block | KnownBlock)[] {
  const stageLabel  = currentStage
    ? `Stage ${done + 1}/${total} · \`${currentStage}\`${stageElapsedMin !== null ? ` · ${stageElapsedMin} min in this stage` : ''}`
    : `${done}/${total} stages complete · finalizing...`
  return [{
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `⏱ *Deployment running longer than usual*\n\`${source} → ${destination}\` on ${formatSite(site, siteId)}\n${stageLabel}\n_${elapsedMin} min total elapsed_`,
    },
  }]
}

export function buildUpcomingBlocks(source: string, destination: string, site: string, scheduledFor: string, siteId?: string): (Block | KnownBlock)[] {
  const dt = new Date(scheduledFor).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Manila' })
  return [{
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `⚡ *Deployment starting in ~10 minutes*\n\`${source} → ${destination}\` on ${formatSite(site, siteId)}\n${dt} (Manila)`,
    },
  }]
}

export function buildScheduledBlocks(source: string, destination: string, site: string, scheduledFor: string, notes?: string, siteId?: string): (Block | KnownBlock)[] {
  const dt = new Date(scheduledFor).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Manila' })
  const notesLine = notes ? `\n_${notes}_` : ''
  return [{
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `📅 *Deployment scheduled*\n\`${source} → ${destination}\` on ${formatSite(site, siteId)}\n${dt} (Manila)${notesLine}`,
    },
  }]
}

export function buildStartedBlocks(source: string, destination: string, site: string, siteId?: string): (Block | KnownBlock)[] {
  return [{
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `🚀 *Deployment started*\n\`${source} → ${destination}\` on ${formatSite(site, siteId)}`,
    },
  }]
}

export function buildApprovalBlocks(
  jobId: string,
  message: string,
  approveLabel: string,
  rejectLabel: string,
): (Block | KnownBlock)[] {
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `◈ *Approval required*\n${message}` },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: approveLabel, emoji: true },
          style: 'primary',
          value: JSON.stringify({ jobId, approved: true }),
          action_id: 'deployment_approve',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: rejectLabel, emoji: true },
          style: 'danger',
          value: JSON.stringify({ jobId, approved: false }),
          action_id: 'deployment_reject',
        },
      ],
    },
  ]
}

export function buildCompleteBlocks(source: string, destination: string, site: string, stages: string[], siteId?: string): (Block | KnownBlock)[] {
  return [{
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `✅ *Deployment complete*\n\`${source} → ${destination}\` on ${formatSite(site, siteId)}\nStages: ${stages.join(' → ')}`,
    },
  }]
}

export function buildFailedBlocks(source: string, destination: string, site: string, reason: string, siteId?: string): (Block | KnownBlock)[] {
  return [{
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `❌ *Deployment failed*\n\`${source} → ${destination}\` on ${formatSite(site, siteId)}\n${reason}`,
    },
  }]
}

export function buildPausedBlocks(source: string, destination: string, site: string, pausedAfter: string, siteId?: string): (Block | KnownBlock)[] {
  return [{
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `⏸ *Deployment paused*\n\`${source} → ${destination}\` on ${formatSite(site, siteId)}\nPaused after \`${pausedAfter}\` — re-run from the console to continue.`,
    },
  }]
}

export function buildCancelledBlocks(
  source: string, destination: string, site: string,
  reason: string, completedStages: string[], scheduled: boolean,
  siteId?: string,
): (Block | KnownBlock)[] {
  const stageCtx = completedStages.length > 0
    ? `Completed: ${completedStages.join(' → ')}`
    : 'No stages completed'
  const typeLabel = scheduled ? 'Scheduled deployment' : 'Deployment'
  return [{
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `🚫 *${typeLabel} cancelled*\n\`${source} → ${destination}\` on ${formatSite(site, siteId)}\n${reason}\n_${stageCtx}_`,
    },
  }]
}
