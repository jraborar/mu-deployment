-- Run this in your Supabase SQL editor

create table if not exists deployment_history (
  id              uuid primary key default gen_random_uuid(),
  site            text not null,
  source          text not null,
  destination     text not null,
  stages_completed text[] not null default '{}',
  status          text not null,
  started_at      timestamptz not null,
  completed_at    timestamptz,
  logs            jsonb not null default '[]'
);

create index on deployment_history (site, started_at desc);

create table if not exists scheduled_deployments (
  id              uuid primary key default gen_random_uuid(),
  site            text not null,
  source          text not null,
  destination     text not null,
  scheduled_for   timestamptz not null,
  status          text not null default 'pending',
  notes           text,
  created_at      timestamptz not null default now()
);

create index on scheduled_deployments (status, scheduled_for asc);

-- Row-level security (enable after configuring your service role key)
-- alter table deployment_history enable row level security;
-- alter table scheduled_deployments enable row level security;
