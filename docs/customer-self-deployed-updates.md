# Runbook: customer deploys a booked update themselves

Sometimes a Managed Updates customer deploys a staged update to live on their own —
through the Pantheon dashboard or their own process — before the deployment this app
auto-booked after staging has fired. This doc covers how to recognize that and close
it out correctly.

## How to recognize it

The customer confirms (or you notice) the site is already live with the staged
changes, but the **Upcoming** tab (or the site's row in mu-sites) still shows a
`pending` deployment booked for a future date. That row was created automatically
right after the staging run in mu-wp-staging (`consultant: "WP Staging"`), and — left
alone — the scheduler will fire it again on its `scheduled_for` date and redeploy on
top of whatever the customer already shipped.

## Why "just Cancel" isn't enough

Clicking the plain ✕ **Cancel** button only flips `scheduled_deployments.status` to
`cancelled`. It stops the redundant redeploy, but that's the extent of it —
`scheduled_deployments` and its `status` are never consulted for the on-time / late /
missed determination mu-sites shows on a site's timeline; that call is made purely
from `deployment_history` (see `classify()` in mu-sites' `lib/cards.ts`). Since no
pipeline run ever happened here, there's no `deployment_history` row — so the site's
window keeps rendering as **staged, never deployed** (or eventually **missed**) even
though it *was* deployed, just not through this app.

## What to do instead: "✓ Deployed"

In the **Upcoming** tab, use **✓ Deployed** instead of ✕ on the affected row:

1. Enter the date/time (Manila) the customer actually deployed.
2. Confirm.

This calls `POST /api/schedule/deployed` → `markScheduleCustomerDeployed()`
(`lib/supabase.ts`), which in one step:

- Inserts a `completed` row into `deployment_history` for that `source` →
  `destination`, with `completed_at` set to the time you entered — the row mu-sites
  actually reads to render the week as deployed.
- Sets the `scheduled_deployments` row's status to `customer-deployed` — kept
  **distinct from `cancelled`** so later reporting can still tell "the customer beat
  us to it" apart from a deploy that was abandoned or skipped outright.

No pipeline stages run; this only backfills the record.

## Reference: `scheduled_deployments.status` values

| status | meaning |
|---|---|
| `pending` | booked, not yet due |
| `triggered` | the scheduler fired it (pipeline ran through this app) |
| `cancelled` | withdrawn — no deploy happened, and none should be inferred |
| `customer-deployed` | the customer deployed it outside this app; backfilled, not run |

## Worked example — Urban Grid Solar, Sep 2026

The Sep 3, 2026 WP staging run for Urban Grid Solar (`mu-260903`) auto-booked a
`live` deployment for Sep 9. The customer deployed it themselves on Sep 4. The
`pending` schedule (id `2f3d86ae-…`) was closed out with **✓ Deployed** using a
Sep 4 completion time, which inserted the matching `deployment_history` row and
retired the schedule as `customer-deployed` — preventing the Sep 9 auto-redeploy and
letting mu-sites show that week as deployed.
