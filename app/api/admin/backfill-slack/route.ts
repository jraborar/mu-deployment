import { createClient } from '@supabase/supabase-js'
import { WebClient } from '@slack/web-api'

export const runtime = 'nodejs'

// One-shot migration: finds past Slack messages that mention a site by UUID only
// and edits them to include the human-readable site name alongside the ID.
//
// Only works for Slack (Bot Token + channel). Pumble uses an incoming webhook
// with no update API, so past Pumble messages cannot be retroactively edited.
//
// Requires CRON_SECRET to be set — call with:
//   curl -X POST https://<host>/api/admin/backfill-slack \
//     -H "Authorization: Bearer <CRON_SECRET>"

const SEARCH_WINDOW_SEC = 300 // ±5 minutes around started_at

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
  if (!bot || !ch)  return Response.json({ error: 'Slack Bot Token / Channel ID not configured — Pumble-only setups cannot update past messages' }, { status: 503 })

  const db    = createClient(url, key)
  const slack = new WebClient(bot)

  // Fetch records that have a resolved site_name — column-to-column inequality
  // is handled in JS below since PostgREST doesn't support it directly.
  const { data: records, error } = await db
    .from('deployment_history')
    .select('id, site, site_name, source, destination, started_at')
    .not('site_name', 'is', null)
    .order('started_at', { ascending: false })
    .limit(200)

  if (error) return Response.json({ error: error.message }, { status: 500 })

  // Filter to records where site_name is meaningfully different from site
  const targets = (records ?? []).filter(
    r => r.site_name && r.site_name !== r.site
  )

  let checked = 0
  let updated = 0
  const skipped: string[] = []

  for (const rec of targets) {
    const startedTs = new Date(rec.started_at).getTime() / 1000
    const oldest    = String(startedTs - SEARCH_WINDOW_SEC)
    const latest    = String(startedTs + SEARCH_WINDOW_SEC)

    let messages: { ts?: string; text?: string; blocks?: unknown[] }[] = []
    try {
      const res = await slack.conversations.history({
        channel: ch,
        oldest,
        latest,
        limit: 20,
      })
      messages = (res.messages ?? []) as typeof messages
    } catch (err) {
      skipped.push(`${rec.id}: history fetch failed — ${String(err)}`)
      continue
    }

    for (const msg of messages) {
      if (!msg.ts || !msg.text) continue
      if (!msg.text.includes(rec.site)) continue

      checked++
      const replacement = `${rec.site_name} (\`${rec.site}\`)`
      // Replace backtick-wrapped UUID: `<uuid>` → SiteName (`<uuid>`)
      const newText = msg.text.replace(new RegExp(`\`${rec.site}\``, 'g'), replacement)

      // Rebuild blocks with the same replacement applied to mrkdwn text fields
      const newBlocks = rebuildBlocks(msg.blocks, rec.site, replacement)

      try {
        await slack.chat.update({
          channel: ch,
          ts: msg.ts,
          text: newText,
          ...(newBlocks.length ? { blocks: newBlocks } : {}),
        })
        updated++
      } catch (err) {
        skipped.push(`ts=${msg.ts}: update failed — ${String(err)}`)
      }
    }
  }

  return Response.json({
    targets: targets.length,
    checked,
    updated,
    skipped,
    note: 'Pumble messages cannot be retroactively updated (no update API on incoming webhooks).',
  })
}

function rebuildBlocks(blocks: unknown[] | undefined, siteId: string, replacement: string): unknown[] {
  if (!blocks) return []
  return blocks.map(block => {
    const b = block as Record<string, unknown>
    if (b.type === 'section' && b.text) {
      const t = b.text as Record<string, unknown>
      if (typeof t.text === 'string') {
        return {
          ...b,
          text: {
            ...t,
            text: t.text.replace(new RegExp(`\`${siteId}\``, 'g'), replacement),
          },
        }
      }
    }
    return block
  })
}
