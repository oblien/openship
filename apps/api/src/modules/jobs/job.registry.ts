/**
 * System job registry — the code side of the generic job schedule.
 *
 * Each entry declares a built-in task's key, label, default cron, action
 * (`run`), and optional platform gate (`available`). The `job` table seeds one
 * row per entry; reconcileJobs resolves a row's action back to its `run` here
 * by `key` (system-job actions are code, not stored).
 *
 * Adding a system job = add an entry here. Its schedule row is auto-seeded on
 * next boot and becomes observable + operator-tunable via the Jobs module.
 *
 * Keys match the historical runner jobIds so job_run history and any persisted
 * BullMQ repeatables carry over. Billing-anniversary stays outside this registry
 * (CLOUD_MODE-only, not a self-hosted concern).
 */

import { repos } from "@repo/db";
import { platform } from "../../lib/controller-helpers";
import { renewExpiringCerts } from "../../lib/ssl-scheduler";
import { runOrphanSweep } from "../projects/orphan-gc-schedule";
import { runRetentionSweep } from "../backups/retention-prune";
import { runBackupStaleSweep } from "../backups/backup-stale-sweep";
import { pruneAuditEvents } from "../audit/audit-prune";
import { runReconcileSweep } from "../deployments/reconcile-schedule";
import { runImageGcSweep } from "../deployments/image-gc";
import { verifyPendingDomains } from "../domains/domain.service";
import { runEdgeVerifySweep } from "../domains/edge-verify-schedule";
import { scanInstanceUpdates } from "../updates/updates.service";
import { scanInstanceModules } from "../system/server-modules.service";
import { scanInstanceContainers } from "../system/server-containers.service";
import { runHealthWatch, pruneResolvedIncidents } from "../monitoring/health-watch";
import { runUsageSampleSweep } from "../monitoring/usage-sampler";
import { runAnalyticsScrapeSweep } from "../system/analytics-scraper";
import { runDueOnceJobs } from "./job-command";
import type { JobSummary } from "../../lib/system-jobs";

export interface SystemJobDef {
  key: string;
  label: string;
  defaultCron: string;
  run: () => Promise<JobSummary>;
  /** Platform gate — when false the job isn't seeded/scheduled here (e.g. SSL
   *  renewal only on self-hosted certbot installs). Defaults available. */
  available?: () => boolean;
}

const WEBHOOK_EVENT_RETENTION_DAYS = 30;
const JOB_RUN_RETENTION_DAYS = 30;
/**
 * Traffic analytics. Two horizons because the two tables differ by three orders of
 * magnitude in row cost: `server_analytics` is one row per domain per MINUTE
 * (~525k rows/domain/year) and only feeds the live chart, while
 * `server_analytics_geo` is one row per domain per DAY and is the long-term
 * history behind the country map. Nothing pruned either before, so both grew
 * without bound for the life of the install.
 */
const ANALYTICS_BUCKET_RETENTION_DAYS = 90;
const ANALYTICS_ROLLUP_RETENTION_DAYS = 400;
/**
 * Resource usage samples. The DENSEST of the three — one row per service per 5-minute
 * bucket is ~288/day/service, against 1440/day/domain for traffic but spread over far
 * more series on a busy install. Shortest horizon of the three for that reason.
 */
const RESOURCE_USAGE_RETENTION_DAYS = 30;

export const SYSTEM_JOB_DEFS: SystemJobDef[] = [
  {
    key: "ssl:renew",
    label: "SSL certificate renewal",
    defaultCron: "17 3 * * *",
    // Cloud manages TLS at Oblien's edge; desktop has a noop SSL provider.
    available: () => platform().target === "selfhosted",
    run: async () => {
      const r = await renewExpiringCerts();
      return { renewed: r.renewed, failed: r.failed, total: r.total };
    },
  },
  {
    key: "projects:orphan-gc",
    label: "Orphaned resource cleanup",
    defaultCron: "41 * * * *",
    run: async () => runOrphanSweep(),
  },
  {
    key: "images:gc",
    label: "Built-image garbage collection",
    // Off-peak daily. Prunes each project's superseded build images beyond the
    // rollback window on its deploy host. Cloud (SaaS) workloads live on Oblien,
    // not local Docker, so there's nothing to sweep there.
    defaultCron: "23 4 * * *",
    available: () => platform().target !== "cloud",
    run: async () => {
      const r = await runImageGcSweep();
      return {
        scanned: r.projectsScanned,
        removed: r.imagesRemoved,
        bytesReclaimed: r.bytesReclaimed,
        skipped: r.skippedInUse,
        failed: r.errors,
      };
    },
  },
  {
    key: "permissions:pending-grant-prune",
    label: "Pending grant prune",
    defaultCron: "33 3 * * *",
    run: async () => ({ deleted: await repos.invitationPendingGrant.sweepDeadInvitations() }),
  },
  {
    key: "retention-prune-daily",
    label: "Backup retention prune",
    defaultCron: "17 3 * * *",
    run: async () => runRetentionSweep(),
  },
  {
    key: "backups:stale-run-sweep",
    label: "Backup in-flight stale reconciliation",
    // Every five minutes — short enough to unblock queued siblings when an
    // uploading run wedged without an API restart (#516).
    defaultCron: "*/5 * * * *",
    run: async () => runBackupStaleSweep(),
  },
  {
    key: "audit:retention-prune",
    label: "Audit log prune",
    defaultCron: "17 3 * * *",
    run: async () => pruneAuditEvents(),
  },
  {
    key: "github:webhook-event-prune",
    label: "GitHub webhook event prune",
    defaultCron: "47 3 * * *",
    run: async () => {
      const cutoff = new Date(Date.now() - WEBHOOK_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
      const deleted = await repos.webhookDelivery.pruneOlderThan(cutoff);
      return { deleted };
    },
  },
  {
    key: "analytics:scrape",
    label: "Traffic analytics collection",
    // Every ~30 min, off the :00/:30 marks. The ceiling is the edge's shared-dict
    // TTL — 24h for minute buckets, 48h for the daily rollup — because anything
    // still in RAM when its key expires is gone for good. Well inside that: a
    // missed tick or a box down for a few hours costs nothing, and the same shape
    // of work (one connect per server) already runs every MINUTE for
    // services:health-watch, so this is not a new cost profile.
    //
    // Only a seed — the job row is authoritative once created, so an operator with
    // many servers can stretch it from the Jobs UI without a code change.
    defaultCron: "13,43 * * * *",
    // Cloud has no managed servers and no OpenResty: on the SaaS, traffic analytics
    // live at Oblien's edge and are read through, never scraped into our DB.
    available: () => platform().target !== "cloud",
    run: async () => runAnalyticsScrapeSweep(),
  },
  {
    key: "resources:sample",
    label: "Resource usage sampling",
    // :01, :06, :11 … — every 5 minutes, off the :00/:30 marks every other install
    // also fires on. The cadence IS the chart's resolution: unlike traffic, which the
    // edge counts for free, each sample is an active `docker stats` costing the daemon
    // roughly a second, so sampling faster buys detail at a real and growing price.
    // Only a seed — the job row wins afterwards, so a large estate can stretch it.
    defaultCron: "1-59/5 * * * *",
    // Desktop has no always-on process to sample from. Cloud is deliberately NOT
    // excluded: CloudRuntime implements getUsage, so Oblien-hosted projects get
    // history too — riding the health watch's `selfhosted` gate would have denied it.
    available: () => platform().target !== "desktop",
    run: async () => runUsageSampleSweep(),
  },
  {
    key: "analytics:retention-prune",
    label: "Traffic analytics prune",
    defaultCron: "23 4 * * *",
    // Only the self-hosted control plane scrapes OpenResty into these tables; on
    // the SaaS, traffic analytics live at Oblien's edge and are read through, never
    // persisted here, so there is nothing local to prune.
    available: () => platform().target !== "cloud",
    run: async () => {
      const day = 24 * 60 * 60 * 1000;
      const buckets = await repos.analytics.pruneBuckets(
        Math.floor((Date.now() - ANALYTICS_BUCKET_RETENTION_DAYS * day) / 60_000),
      );
      const rollups = await repos.analytics.pruneGeo(
        new Date(Date.now() - ANALYTICS_ROLLUP_RETENTION_DAYS * day)
          .toISOString()
          .slice(0, 10)
          .replace(/-/g, ""),
      );
      return { buckets, rollups };
    },
  },
  {
    key: "resources:retention-prune",
    label: "Resource usage prune",
    defaultCron: "29 4 * * *",
    // Matches resources:sample's gate, NOT analytics:retention-prune's. Collection
    // and pruning must be available in the same places or the difference is a leak:
    // usage IS sampled on cloud (CloudRuntime implements getUsage), so folding this
    // into the cloud-excluded analytics prune would have let SaaS rows accumulate
    // forever — at ~288/day/service, indefinitely.
    available: () => platform().target !== "desktop",
    run: async () => {
      const cutoffMinute = Math.floor(
        (Date.now() - RESOURCE_USAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000) / 60_000,
      );
      return { deleted: await repos.resourceUsage.pruneOlderThan(cutoffMinute) };
    },
  },
  {
    key: "deployments:reconcile",
    label: "Deployment reconcile",
    defaultCron: "*/10 * * * *",
    run: async () => runReconcileSweep(),
  },
  {
    key: "domains:verify-pending",
    label: "Domain DNS verification",
    // TWO phases, one sweep: (1) re-check pending custom domains and flip them to
    // verified once DNS propagates, (2) finish TLS for domains that verified but
    // whose first issuance failed — those sat in `provisioning` forever, needing a
    // manual Verify + Redeploy (#289), because the verify sweep only selects
    // unverified rows and the renewal sweep only selects certs that already exist.
    // Off the :00/:30 marks. This also runs in Desktop: the local API resolves
    // each project's active deployment and performs verification/cert work on
    // that remote server over its stored SSH connection.
    defaultCron: "*/13 * * * *",
    run: async () => {
      const r = await verifyPendingDomains();
      return {
        verified: r.verified,
        failed: r.failed,
        pending: r.stillPending,
        total: r.total,
        sslIssued: r.sslIssued ?? 0,
        sslRetrying: r.sslRetrying ?? 0,
      };
    },
  },
  {
    key: "edge:target-verify",
    label: "Free-domain target verification",
    // Openship Cloud proves target control ONCE and re-probes the SAME token before
    // the 90-day expiry, so the standing job is to still be answering then. Deploys
    // re-assert the token already; this covers the box that deploys nothing for three
    // months and loses its host state dir in between — the failure that otherwise
    // surfaces as a free domain dying ~83 days after a green deploy, with nothing
    // anywhere saying why. Daily is ample against a 7-day renewal window. Cloud
    // routes its own workloads through Oblien's edge and has no target to prove.
    defaultCron: "43 5 * * *",
    available: () => platform().target !== "cloud",
    run: async () => {
      const r = await runEdgeVerifySweep();
      return {
        targets: r.targets,
        serving: r.serving,
        notServing: r.notServing,
        renewingSoon: r.renewingSoon,
        reverified: r.reverified,
        failed: r.failed,
      };
    },
  },
  {
    key: "updates:scan",
    label: "Update scan",
    // Warms the one channel for "is anything out of date?" — polls what each
    // app/project/self-app/webmail's SOURCE currently offers and caches it in
    // update_status, so the home Updates block, Apps tab and issues feed read a
    // table instead of hitting registries/GitHub per page load. Off-peak, off the
    // :00/:30 marks; not on desktop.
    //
    // NOT the only writer, and nothing depends on it having run: those reads are
    // read-through and poll whatever the cache can't answer (which is also why
    // updates work on desktop, where this job doesn't exist).
    //
    // No "behind" count here on purpose: whether a project is behind depends on
    // what's deployed right now, which is compared at read time — the scan only
    // refreshes the upstream side.
    defaultCron: "19 */6 * * *",
    available: () => platform().target !== "desktop",
    run: async () => {
      const r = await scanInstanceUpdates();
      return { scanned: r.scanned, supported: r.supported };
    },
  },
  {
    key: "modules:scan",
    label: "Native-module update scan",
    // Detect drift for server-installed infra (OpenResty, …) against the signed
    // catalog and cache it in server_module_status so the Components tab renders
    // "vX → vY, Update" without re-probing. Detection only — never auto-applies
    // (auto/consent apply is explicit). Off-peak, self-hosted only.
    defaultCron: "37 */6 * * *",
    available: () => platform().target === "selfhosted",
    run: async () => {
      const r = await scanInstanceModules();
      return { servers: r.servers, behind: r.behind };
    },
  },
  {
    key: "infra:scan",
    label: "Managed-container update scan",
    // The container sibling of modules:scan. Detect edge/mail image drift on
    // every connected server (running tag != the tag this control plane pins to
    // APP_VERSION) and cache it in server_container_status. When the instance
    // opted into autoUpdateInfra, the same pass ALSO swaps behind containers —
    // otherwise detection only, surfaced as an advisory. Desktop + self-hosted
    // (both self-update their control plane and manage remote boxes), never
    // cloud. Off-peak, off the :00/:30 marks.
    defaultCron: "43 */6 * * *",
    available: () => platform().target !== "cloud",
    run: async () => {
      const r = await scanInstanceContainers();
      return { servers: r.servers, behind: r.behind, updated: r.updated };
    },
  },
  {
    key: "services:health-watch",
    label: "Container health watch",
    // Every minute. This is the ONLY thing that notices a container died after
    // its deploy window closed, and detection latency is roughly two ticks (a
    // fault must be seen twice before it alerts) — so the interval IS the
    // feature. Cheap by construction: one `docker ps -a` per server, and no DB
    // writes at all on a tick where nothing is wrong.
    defaultCron: "* * * * *",
    // Cloud workloads run on Oblien, whose runtime exposes no stability probe;
    // desktop has no always-on process to poll from.
    available: () => platform().target === "selfhosted",
    run: async () => runHealthWatch(),
  },
  {
    key: "incidents:prune",
    label: "Incident history prune",
    defaultCron: "51 4 * * *",
    available: () => platform().target === "selfhosted",
    run: async () => pruneResolvedIncidents(),
  },
  {
    key: "jobs:oneshot",
    label: "One-time job dispatcher",
    // Fires due one-time (scheduleType=once) custom jobs — the runner has no
    // delayed schedule, so we poll every minute.
    defaultCron: "* * * * *",
    run: async () => runDueOnceJobs(),
  },
  {
    key: "jobs:run-prune",
    label: "Job run history prune",
    defaultCron: "23 4 * * *",
    run: async () => {
      const cutoff = new Date(Date.now() - JOB_RUN_RETENTION_DAYS * 24 * 60 * 60 * 1000);
      await repos.jobRun.pruneOlderThan(cutoff);
      return {};
    },
  },
];

export const SYSTEM_JOB_BY_KEY = new Map(SYSTEM_JOB_DEFS.map((d) => [d.key, d]));
