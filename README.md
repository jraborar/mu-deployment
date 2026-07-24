# Mu Deployment

A Next.js deployment console for pushing Pantheon multidev environments through the dev → test → live pipeline with real-time log streaming, per-stage approval gates, scheduled deployments, and full history via Supabase.

---

## Features

- **Pipeline deployment** — source a multidev (or standard env) and deploy through any combination of stages
- **Per-stage approval gates** — pause between dev, test, and live; approve or stop at each step
- **Alignment check** — detects when dev is ahead of the source multidev and offers to merge dev first
- **Real-time console** — SSE-streamed Terminus output with live/paused/done indicators
- **Cancel** — stop a running deployment mid-pipeline
- **Reconnect** — resume a live stream after a page refresh
- **Scheduled deployments** — schedule future deployments with a default date computed as 3 business days from multidev creation
- **Deployment history** — every run (including crashes) is recorded to Supabase with start/end timestamps and full log
- **Local scheduler** — checks for due scheduled deployments every minute, auto-starts on page load
- **GitHub Actions cron** — `POST /api/cron/trigger` is the production trigger endpoint

---

## Prerequisites

- Node.js 18+
- [Terminus](https://pantheon.io/docs/terminus) installed and authenticated (`terminus auth:login`)
- Git (for the multidev alignment check)
- [Supabase](https://supabase.com) account (free tier) for history and scheduling

---

## Setup

```bash
git clone https://github.com/jraborar/mu-deployment.git
cd mu-deployment
npm install
cp .env.local.example .env.local
```

Fill in `.env.local`:

```
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
CRON_SECRET=your-secret          # optional, protects /api/cron/trigger in production
```

Run the schema in your Supabase SQL editor (`supabase/schema.sql`), then:

```bash
npm run dev
```

App runs at **http://localhost:3000** (or 3001 if 3000 is taken).

---

## Usage

### Deploy tab
1. Enter the Pantheon site ID
2. Enter the source — a multidev name (e.g. `autopilot`, `mu-260724`) or a standard env (`dev`, `test`)
3. Select the final destination (`dev`, `test`, or `live`)
4. Click **▶ Start Deployment**
5. Approve or pause at each stage gate as prompted

### Schedule tab
- Source names following the `mu-YYMMDD` pattern auto-compute a default deployment date (3 business days from creation)
- Other source names query Terminus for the multidev creation date
- Override the date as needed and save

### History tab
- Lists all deployments including those interrupted by server restarts (status: `running`)

---

## API routes

| Route | Method | Purpose |
|---|---|---|
| `/api/deploy` | POST | Start a deployment, returns SSE stream |
| `/api/deploy/[jobId]` | GET | Reconnect to an existing job stream |
| `/api/deploy/[jobId]/cancel` | POST | Cancel a running deployment |
| `/api/approve/[jobId]` | POST | Approve or reject an approval gate |
| `/api/cron/trigger` | POST | Trigger due scheduled deployments |
| `/api/multidev-info` | GET | Fetch multidev creation date from Terminus |
| `/api/schedule` | GET/POST/DELETE | List, create, cancel scheduled deployments |
| `/api/deployments` | GET | Deployment history from Supabase |

---

## Production cron (GitHub Actions)

`.github/workflows/scheduler.yml` runs `POST /api/cron/trigger` on a schedule. Set `APP_URL` and `CRON_SECRET` in your GitHub repo secrets.

---

## Development workflow

```bash
npm run ship    # commit changes → create pr-XXXX branch → open PR for review
```

Requires [GitHub CLI](https://cli.github.com): `brew install gh && gh auth login`

---

## Tech stack

- **Next.js 16** (Turbopack) · **React 19** · **TypeScript** · **Tailwind CSS**
- **Pantheon Terminus** — all deployment operations
- **Supabase** — deployment history and scheduling
- **Server-Sent Events** — real-time log streaming
