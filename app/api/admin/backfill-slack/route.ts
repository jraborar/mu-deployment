import { createClient } from '@supabase/supabase-js'
import { WebClient } from '@slack/web-api'

export const runtime = 'nodejs'

// One-shot migration: posts a correction summary to Slack listing all historical
// deployments with both site name and site ID. Uses only chat:write — no
// channels:history scope needed, so old messages are not edited.
//
// Pumble is also notified via the existing webhook if configured.
//
// Requires CRON_SECRET to be set — call with:
//   curl -X POST https://<host>/api/admin/backfill-slack \
//     -H "Authorization: Bearer <CRON_SECRET>"

const PUMBLE_WEBHOOK_URL = process.env.PUMBLE_WEBHOOK_URL ?? ''
const BOT_NAME           = 'Pantheon MU Deployment'
const PANTHEON_ICON      = 'https://avatars.githubusercontent.com/u/1043537'

export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET
  if (secret) {
    const auth = request.headers.get('authorization')
    if (auth !== `Bearer ${secret}`) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL  ?? ''
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
  const bot = process.env.SLACK_BOT_TOKEN  ?? ''
  const ch  = process.env.SLACK_CHANNEL_ID ?? ''

  if (!url || !key) return Response.json({ error: 'Supabase not configured' }, { status: 503 })

  const db = createClient(url, key)

  // Records where site_name is resolved and different from the raw site ID
  const { data: records, error } = await db
    .from('deployment_history')
    .select('id, site, site_name, source, destination, started_at, status')
    .not('site_name', 'is', null)
    .order('started_at', { ascending: true })
    .limit(200)

  if (error) return Response.json({ error: error.message }, { status: 500 })

  const targets = (records ?? []).filter(r => r.site_name && r.site_name !== r.site)

  if (targets.length === 0) {
    return Response.json({ message: 'No records to backfill — all deployments already have site name = site ID or no name resolved.' })
  }

  const fmt = (iso: string) =>
    new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila' })

  const lines = targets.map(r =>
    `• *${r.site_name}* (\`${r.site}\`) — \`${r.source} → ${r.destination}\` · ${fmt(r.started_at)} · _${r.status}_`
  )

  const text = `📋 *Site ID ↔ Name Reference — Historical Deployments*\nPast notifications showed only the site ID. Here is the full mapping:\n\n${lines.join('\n')}`

  const blocks = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `📋 *Site ID ↔ Name Reference — Historical Deployments*\nPast notifications showed only the site ID. Here is the full mapping:` },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: lines.join('\n') },
    },
  ]

  const posted: string[] = []
  const failed: string[] = []

  // Post to Slack
  if (bot && ch) {
    try {
      const slack = new WebClient(bot)
      await slack.chat.postMessage({
        channel: ch, text, blocks,
        username: BOT_NAME, icon_url: PANTHEON_ICON,
      })
      posted.push('Slack')
    } catch (err) {
      failed.push(`Slack: ${String(err)}`)
    }
  } else {
    failed.push('Slack: SLACK_BOT_TOKEN or SLACK_CHANNEL_ID not configured')
  }

  // Post to Pumble
  if (PUMBLE_WEBHOOK_URL) {
    try {
      const res = await fetch(PUMBLE_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, blocks, username: BOT_NAME, icon_url: PANTHEON_ICON }),
      })
      if (res.ok) posted.push('Pumble')
      else failed.push(`Pumble: HTTP ${res.status}`)
    } catch (err) {
      failed.push(`Pumble: ${String(err)}`)
    }
  }

  return Response.json({ records: targets.length, posted, failed })
}
