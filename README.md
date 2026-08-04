# MU (Managed Updates) Deployment

A Next.js deployment console for pushing Pantheon multidev environments through the dev → test → live pipeline with real-time log streaming, per-stage approval gates, scheduled deployments, and full history via Supabase.

**Live:** <https://mu-deployment-production.up.railway.app>

---

## Features

- **Pipeline deployment** — source a multidev (or standard env) and deploy through any combination of stages
- **Per-stage approval gates** — pause between dev, test, and live; approve or stop at each step
- **Alignment check** — detects when dev is ahead of the source multidev and offers to merge dev first
- **Real-time console** — SSE-streamed Terminus output with live/paused/done indicators
- **Cancel & Force Stop** — cancel a running deployment or force-evict a stuck job directly from the History tab
- **Reconnect** — resume a live stream after a page refresh
- **Scheduled deployments** — schedule future deployments with a default date computed as 3 business days from multidev creation
- **Deployment history** — every run is recorded to Supabase with start/end timestamps, site name, and status; running records from crashed servers are auto-cleaned on startup
- **Live section** — History tab surfaces all currently running jobs (in-memory and Supabase) in a Live section separate from past deployments
- **Auto scheduler** — checks for due scheduled deployments every minute; auto-fails stuck in-memory jobs after 24 hours
- **Slack & Pumble notifications** — deployment started, approved, complete, failed, paused, scheduled, and long-running alerts posted as thread replies; all messages include both site name and site ID

---

## Running the app

### Option A — Railway (recommended)

The app is hosted at <https://mu-deployment-production.up.railway.app> and deploys automatically on every merge to `main`. No local setup required.

### Option B — Local development

**Prerequisites:**

- Node.js 18+
- [Terminus](https://pantheon.io/docs/terminus) installed and authenticated (`terminus auth:login`)
- Git (for the multidev alignment check)
- [Supabase](https://supabase.com) account (free tier) for history and scheduling

```bash
git clone https://github.com/jraborar/mu-deployment.git
cd mu-deployment
npm install
cp .env.local.example .env.local
```

Fill in `.env.local`:

```env
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
TERMINUS_TOKEN=your-terminus-machine-token
CRON_SECRET=your-secret          # protects /api/cron/trigger and admin endpoints
```

Run the schema in your Supabase SQL editor (`supabase/schema.sql`), then:

```bash
npm run dev
```

App runs at <http://localhost:3000> (or 3001 if 3000 is taken).

---

## Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Supabase service role key |
| `TERMINUS_TOKEN` | Yes (Railway) | Pantheon machine token for Terminus auth |
| `CRON_SECRET` | Recommended | Bearer token protecting cron and admin routes |
| `SLACK_BOT_TOKEN` | Optional | Slack bot token (`xoxb-...`) for notifications |
| `SLACK_CHANNEL_ID` | Optional | Slack channel to post to |
| `SLACK_WEBHOOK_URL` | Optional | Slack incoming webhook (fallback if no bot token) |
| `PUMBLE_WEBHOOK_URL` | Optional | Pumble incoming webhook for notifications |
| `SLACK_APP_TOKEN` | Optional | App-level token (`xapp-...`) for Socket Mode approvals |
| `PUMBLE_SIGNING_SECRET` | Optional | Pumble signing secret for interaction verification |

---

## Usage

### Deploy tab

1. Enter the Pantheon site ID
2. Enter the source — a multidev name (e.g. `autopilot`, `mu-260724`) or a standard env (`dev`, `test`)
3. Enter a commit label (auto-filled from source name)
4. Select the final destination (`dev`, `test`, or `live`)
5. Click **▶ Start Deployment**
6. Approve or pause at each stage gate as prompted

### Schedule tab

- Source names following the `mu-YYMMDD` pattern auto-compute a default deployment date (3 business days from creation)
- Other source names query Terminus for the multidev creation date
- Override the date as needed and save

### Upcoming tab

- Lists all pending scheduled deployments with edit, run-now, and cancel options

### History tab

- **Live section** — shows all currently running jobs: in-memory jobs with full log streaming and stage indicators, plus any Supabase `running` records not tracked in the current server instance
- **Force Stop** — each Live card has a Force Stop button (with confirmation) to evict a stuck job without restarting Railway
- **Past section** — completed, failed, paused, and cancelled deployments with site name, site ID, pipeline, and timestamps

---

## API routes

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/deploy` | POST | Start a deployment, returns SSE stream |
| `/api/deploy/[jobId]` | GET | Reconnect to an existing job stream |
| `/api/deploy/[jobId]/cancel` | POST | Cancel a running deployment |
| `/api/deploy/[jobId]/evict` | POST | Force-fail a stuck in-memory job |
| `/api/approve/[jobId]` | POST | Approve or reject an approval gate |
| `/api/jobs` | GET | List currently running in-memory jobs |
| `/api/deployments` | GET | Deployment history from Supabase |
| `/api/schedule` | GET/POST/PATCH/DELETE | List, create, edit, cancel scheduled deployments |
| `/api/multidev-info` | GET | Fetch multidev creation date from Terminus |
| `/api/site-name` | GET | Resolve Pantheon site label from Terminus |
| `/api/cron/trigger` | GET/POST | Trigger due scheduled deployments (also starts scheduler on first call) |
| `/api/pumble/interact` | POST | Handle Pumble button interactions |
| `/api/admin/backfill-slack` | POST | One-shot: post a site ID ↔ name reference to Slack/Pumble for historical deployments |

---

## Slack / Pumble setup

### Notifications (Incoming Webhook — simplest)

Set `SLACK_WEBHOOK_URL` or `PUMBLE_WEBHOOK_URL`. Messages are posted as a bot but interactive approvals are not available.

### Full setup with interactive approvals (Slack only)

1. Create a Slack app at [api.slack.com/apps](https://api.slack.com/apps)
2. Add Bot Token Scopes: `chat:write`
3. Enable **Socket Mode** and generate an App Token (`xapp-...`)
4. Under **Interactivity & Shortcuts**, enable interactivity (Socket Mode handles the callback — no public URL needed)
5. Install the app to your workspace
6. Set `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID`, and `SLACK_APP_TOKEN` in Railway

---

## Scheduler

The scheduler starts automatically on the first page load via `GET /api/cron/trigger` and runs every 60 seconds for the lifetime of the server process. It checks for due scheduled deployments and auto-fails any in-memory jobs that have been running for more than 24 hours.

To trigger it externally from any cron service (e.g. UptimeRobot, cron-job.org):

```bash
curl -X POST https://mu-deployment-production.up.railway.app/api/cron/trigger \
  -H "Authorization: Bearer <CRON_SECRET>"
```

---

## Admin utilities

### Backfill site names in past notifications

Past Slack/Pumble notifications sent before the site-name-in-notifications update showed only the raw site UUID. Run this once to post a reference summary to both channels:

```bash
curl -X POST https://mu-deployment-production.up.railway.app/api/admin/backfill-slack \
  -H "Authorization: Bearer <CRON_SECRET>"
```

---

## Development workflow

Requires [GitHub CLI](https://cli.github.com): `brew install gh && gh auth login`

**Branch convention:** Create the PR first (claims the number), then create the linked issue immediately after.

```bash
# 1. Create a descriptive branch
git checkout -b fix/some-bug   # or feat/ or docs/

# 2. Make changes and commit
git add <files>
git commit -m "fix: description of the fix"

# 3. Push and open PR
git push -u origin fix/some-bug
gh pr create --title "fix: description" --body "..."

# 4. Create the linked issue (gets the next number after the PR)
gh issue create --title "Bug: description" --body "..."

# 5. Add Closes #<issue> to the PR description so it auto-closes on merge
gh pr edit <pr-number> --body "... Closes #<issue>"
```

---

## Tech stack

- **Next.js 16** (Turbopack) · **React 19** · **TypeScript 5** · **Tailwind CSS 3**
- **Pantheon Terminus** — all deployment operations via CLI
- **Supabase** — deployment history and scheduling (PostgreSQL + REST API)
- **Server-Sent Events** — real-time log streaming from server to browser
- **Slack Web API / Socket Mode** — notifications and interactive approvals
- **Pumble** — additional notification channel via incoming webhook
- **Railway** — production hosting via Docker (`railway.toml` + `Dockerfile`)
