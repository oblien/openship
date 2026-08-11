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
import { pruneAuditEvents } from "../audit/audit-prune";
import { runReconcileSweep } from "../deployments/reconcile-schedule";
import { runImageGcSweep } from "../deployments/image-gc";
import { verifyPendingDomains } from "../domains/domain.service";
import { scanInstanceUpdates } from "../updates/updates.service";
import { scanInstanceModules } from "../system/server-modules.service";
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
    key: "updates:scan",
    label: "Update scan",
    // The one channel for "is anything out of date?" — refreshes the
    // update_status cache for every app/project/self-app/webmail so the home
    // Updates block + Apps tab read a table instead of hitting registries/GitHub
    // per page load. Off-peak, off the :00/:30 marks; not on desktop.
    defaultCron: "19 */6 * * *",
    available: () => platform().target !== "desktop",
    run: async () => {
      const r = await scanInstanceUpdates();
      return { scanned: r.scanned, supported: r.supported, behind: r.behind };
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
