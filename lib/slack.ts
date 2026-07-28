import { createHmac, timingSafeEqual } from 'crypto'
import { WebClient } from '@slack/web-api'

// ── Slack (Web API + Socket Mode) ─────────────────────────────────────────────

const SLACK_BOT_TOKEN  = process.env.SLACK_BOT_TOKEN  ?? ''
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID ?? ''

export function isSlackConfigured(): boolean {
  return Boolean(SLACK_BOT_TOKEN && SLACK_CHANNEL_ID)
}

let _web: WebClient | null = null
function getWeb(): WebClient | null {
  if (!isSlackConfigured()) return null
  if (!_web) _web = new WebClient(SLACK_BOT_TOKEN)
  return _web
}

async function postSlackMessage(blocks: object[], text: string): Promise<void> {
  const web = getWeb()
  if (!web) return
  try {
    await web.chat.postMessage({ channel: SLACK_CHANNEL_ID, text, blocks })
  } catch (err) {
    console.error('[slack] postMessage failed:', err)
  }
}

// ── Pumble (Incoming Webhook) ─────────────────────────────────────────────────

const PUMBLE_WEBHOOK_URL = process.env.PUMBLE_WEBHOOK_URL ?? ''

export function isPumbleConfigured(): boolean {
  return Boolean(PUMBLE_WEBHOOK_URL)
}

async function postPumbleMessage(blocks: object[], text: string): Promise<void> {
  try {
    const res = await fetch(PUMBLE_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, blocks }),
    })
    if (!res.ok) console.error('[pumble] postMessage failed:', res.status, await res.text())
  } catch (err) {
    console.error('[pumble] postMessage failed:', err)
  }
}

// ── Broadcast to all configured platforms ─────────────────────────────────────

export async function broadcastMessage(blocks: object[], text: string): Promise<void> {
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

export function buildStartedBlocks(source: string, destination: string, site: string): object[] {
  return [{
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `🚀 *Deployment started*\n\`${source} → ${destination}\` on \`${site}\``,
    },
  }]
}

export function buildApprovalBlocks(
  jobId: string,
  message: string,
  approveLabel: string,
  rejectLabel: string,
): object[] {
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

export function buildCompleteBlocks(source: string, destination: string, site: string, stages: string[]): object[] {
  return [{
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `✅ *Deployment complete*\n\`${source} → ${destination}\` on \`${site}\`\nStages: ${stages.join(' → ')}`,
    },
  }]
}

export function buildFailedBlocks(source: string, destination: string, site: string, reason: string): object[] {
  return [{
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `❌ *Deployment failed*\n\`${source} → ${destination}\` on \`${site}\`\n${reason}`,
    },
  }]
}

export function buildPausedBlocks(source: string, destination: string, site: string, pausedAfter: string): object[] {
  return [{
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `⏸ *Deployment paused*\n\`${source} → ${destination}\` on \`${site}\`\nPaused after \`${pausedAfter}\` — re-run from the console to continue.`,
    },
  }]
}
