-- Continuous container health monitoring: the durable memory behind the alerts.
--
-- Openship knew a container had crashed at exactly ONE moment — the ~15s post-deploy
-- stabilization watch. After that nobody looked again, so an OOM-kill at 3am or a
-- Postgres that starts bouncing after a host reboot reached the operator only when a
-- user complained. The health watch closes that, but a poller that alerts on "the
-- container isn't running" gets muted within a day: a redeploy recreating containers,
-- an operator's `docker stop`, an unreachable host, and a crash loop all look exactly
-- like a failure at a point in time.
--
-- So the unit of alerting is an INCIDENT, not a state reading: opened once, escalated
-- only when it gets worse, resolved once with a downtime duration. This table is that
-- memory — it survives the control-plane restart that in-process state would not (a box
-- down for three days must not re-page on every API restart), and it doubles as the
-- project Health tab's history.
CREATE TABLE IF NOT EXISTS "service_incident" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  -- Null for SERVER-scoped incidents (an unreachable box gets ONE incident, not one
  -- per service on it — that fan-out is the single loudest source of alert fatigue).
  "project_id" text REFERENCES "project"("id") ON DELETE CASCADE,
  -- The resolved service row, when there is one. SET NULL, not cascade: deleting a
  -- service must not erase the record of the outage it had (`service_key` still
  -- identifies it, and `service_name` is snapshotted below).
  "service_id" text REFERENCES "service"("id") ON DELETE SET NULL,
  -- Stable identity across a container RECREATE, which is the whole point: every
  -- deploy mints a new container id, so keying incidents on container id would open a
  -- fresh incident for the same workload after each redeploy. Service id when we
  -- resolved one, else the container name (single-app deploys have no service row);
  -- `server:<id>` for server-scoped rows.
  "service_key" text NOT NULL,
  -- Snapshot of the display name at incident time — the alert text must still read
  -- correctly after a rename, and history rows must not silently change meaning.
  "service_name" text NOT NULL,
  "server_id" text REFERENCES "servers"("id") ON DELETE SET NULL,
  "container_id" text,
  -- down | crash_loop | unhealthy | server_unreachable. Ordered by severity in the
  -- watcher: an incident escalates upward (and re-notifies), never downward.
  "kind" text NOT NULL,
  "status" text NOT NULL DEFAULT 'open', -- open | resolved
  "reason" text,
  "exit_code" integer,
  "restart_count" integer NOT NULL DEFAULT 0,
  "oom_killed" boolean NOT NULL DEFAULT false,
  -- Consecutive ticks that agreed on this verdict. An incident is only opened (and
  -- only notified) at >= 2, so a snapshot taken mid-restart or during a slow
  -- healthcheck start never pages anyone.
  "confirmations" integer NOT NULL DEFAULT 0,
  -- Notification bookkeeping. Deliberately a count, not a flag: open, escalation and
  -- resolve each notify exactly once, and nothing else ever does.
  "notify_count" integer NOT NULL DEFAULT 0,
  "notified_at" timestamp,
  "log_excerpt" text,
  "opened_at" timestamp NOT NULL DEFAULT now(),
  "resolved_at" timestamp,
  -- Last tick that actually OBSERVED this workload. Not advanced when the host is
  -- unreachable — during a connectivity loss we know nothing, so nothing is claimed.
  "last_seen_at" timestamp NOT NULL DEFAULT now(),
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- One open incident per workload — the dedup primitive. As a partial unique index,
-- "we are already alerting about this" is a DB invariant rather than sweep
-- bookkeeping: two overlapping ticks (a manual Run now landing on a cron tick) cannot
-- both open one and double-notify.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_service_incident_open"
  ON "service_incident" ("project_id", "service_key")
  WHERE "status" = 'open' AND "project_id" IS NOT NULL;
--> statement-breakpoint
-- Same invariant for server-scoped rows. Needs its own index because Postgres treats
-- NULLs as distinct in a unique index, so the one above would happily allow a second
-- open row for the same box.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_service_incident_open_server"
  ON "service_incident" ("server_id")
  WHERE "status" = 'open' AND "project_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_service_incident_project"
  ON "service_incident" ("project_id", "opened_at" DESC);
--> statement-breakpoint
-- Intent marker. `disableProject` stopped the container and recorded NOTHING, so
-- "the operator turned this off" was unknowable — the health watch would page about
-- every deliberately-disabled project, forever. Set on disable, cleared on enable.
ALTER TABLE "project" ADD COLUMN IF NOT EXISTS "disabled_at" timestamp;
