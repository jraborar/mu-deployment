-- Cadence-anchor flag on scheduled_deployments. Stamped true only by mu-staging's
-- prebookDeployment for a MANAGED staging-cycle deploy (false for security/upstream
-- fast-track; absent/false for manual ad-hoc deploys created directly here). On a
-- successful deploy, mu-deployment advances sites.last_deployment only when true —
-- so manual and fast-track deploys never drift the recurring staging cadence.
alter table public.scheduled_deployments add column if not exists anchor_advance boolean default false;
