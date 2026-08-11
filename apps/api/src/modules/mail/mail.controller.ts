/**
 * Mail setup controller - HTTP endpoints for the iRedMail setup wizard.
 *
 * Self-hosted only (mounted behind `localOnly` + `authMiddleware`).
 *
 * Endpoints:
 *   GET  /mail/steps                → list all setup steps
 *   GET  /mail/status?serverId=…    → current setup progress for a server
 *   POST /mail/setup                → start or resume setup (SSE stream)
 *   POST /mail/setup/cancel         → cancel running setup
 *   POST /mail/setup/dns-ack        → flip the DKIM gate flag
 *   POST /mail/setup/reset          → wipe the on-server state file
 *   GET  /mail/health/:serverId     → live systemd status of mail daemons
 *
 * State model:
 *   - Durable state ("what HAS been installed") lives on the target VPS at
 *     /root/.openship/mail-state.json. Purge the VPS, state goes with it.
 *   - Ephemeral state ("is an install running RIGHT NOW") lives as one
 *     `activeSession` variable in this process. Lost on API restart, which
 *     is fine - if openship restarts mid-install, the on-server state file
 *     still has the completed steps, the SSE caller can retry from where
 *     it left off via the regular Resume button.
 *
 * No openship DB tables involved.
 */

import type { Context } from "hono";
import type { SSEStreamingApi } from "hono/streaming";
import crypto from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { buildMailBackupPayload } from "./admin/backup-plan";
// The mail server is one more backup SOURCE in the general system, so its policy
// goes through the same cron validation + schedule registration as a project's.
import { syncPolicySchedule, validateCronExpression } from "../backups/triggers/cron";
import { streamSSE } from "../../lib/sse";
import { invalidatePlatformTransport } from "../../lib/mail";
import { env } from "../../config";
import { safeErrorMessage, DEFAULT_RETAIN_COUNT } from "@repo/core";
import { sshManager } from "../../lib/ssh-manager";
import { repos } from "@repo/db";
import { getRequestContext, type RequestContext } from "../../lib/request-context";
import { permission } from "../../lib/permission";
// Shared org-scope guard (single implementation in controller-helpers) —
// the mail stack gives SSH-level reach into the box, so a cross-org
// serverId here is the same severity as the terminal hole.
import { isServerInOrg } from "../../lib/controller-helpers";
import type { CommandExecutor } from "@repo/adapters";
import { pinnedEdgeImage } from "../../lib/edge-image";
import { pinnedMailImage } from "../../lib/mail-image";
import { deliverManagedImage } from "../../lib/deliver-managed-image";
import {
  MAIL_SETUP_STEPS,
  TOTAL_STEPS,
  STEP_RUNNERS,
  STEP_TIMEOUT_MS,
  DEFAULT_STEP_TIMEOUT_MS,
  type StepResult,
  type StepLogger,
  type BasicStepFn,
  type InstallerStepFn,
  type SslStepFn,
  type IRedMailConfig,
} from "./mail.service";
import { checkMailDelivery } from "./mail-delivery.service";
import { checkMailHealth, mailIsServing, MAIL_COMPONENTS } from "./mail-health.service";
import { resolveMailEngine } from "./mail-engine";
import { updatePostmasterPassword } from "./mail-credentials.service";
import { reserveMailSetup } from "./mail-setup-lease";
import { preflightMailSetup } from "./mail-setup-preflight";
import { applyRelayToState } from "./admin/outbound-relay.service";
// The webmail is an ordinary project: its status is resolved from the DB, not
// from this server's state file.
import {
  resolveLinkedWebmailProject,
  resolveWebmailSummary,
  type WebmailSummary,
} from "./webmail/webmail-install.service";
import {
  readState,
  writeState,
  mutateState,
  clearState,
  makeFreshState,
  recordStep,
  mergeSecrets,
  appendLog,
  type MailServerState,
  type MailSessionLogLine,
} from "./mail-state";

// ─── In-memory pointer to the currently-running install ──────────────────────

/**
 * One install at a time per process. Tracked in memory only because
 * "running" is a process-local thing - the durable record of "step 8
 * completed" lives in the on-server JSON file.
 */
interface ActiveSession {
  serverId: string;
  domain: string;
  cancelled: boolean;
}

let active: ActiveSession | null = null;

// ─── Status rendering ────────────────────────────────────────────────────────

/**
 * Render an on-server state object into the dashboard-facing payload.
 * The frontend type is the same as before - we just synthesise it from
 * the persistent state plus the in-memory `active` pointer.
 */
function statusFromState(
  state: MailServerState | null,
  serverId: string,
  webmail?: WebmailSummary,
) {
  if (!state) {
    return {
      active: false,
      serverId,
      // Present even with no install state: the webmail is a project of its own,
      // and one can exist (or be mid-build) before or after this server's setup.
      webmail,
      steps: MAIL_SETUP_STEPS.map((s) => ({ ...s, status: "pending" as const })),
    };
  }

  const isActive = active?.serverId === state.serverId;
  const runningStep = isActive ? activeRunningStep(state) : null;

  const stepStatuses = MAIL_SETUP_STEPS.map((step) => {
    const result = state.completedSteps[String(step.id)];
    let status: "pending" | "running" | "completed" | "failed" | "skipped" = "pending";
    if (result?.success) status = "completed";
    else if (result && !result.success) status = "failed";
    else if (runningStep === step.id) status = "running";

    return {
      ...step,
      status,
      message: result?.message,
      warning: result?.warning,
      data: result?.data,
    };
  });

  // Surface the postmaster identity + protocol endpoints - but never the
  // password. The plaintext used to be mirrored back from install for
  // convenience; that's gone. Operators reset via the Change flow whenever
  // they need a known password; the SSHA512 hash in vmail.mailbox is the
  // only source of truth.
  const credentials = state.domain
    ? {
        username: `postmaster@${state.domain}`,
        smtpHost: `mail.${state.domain}`,
        smtpPort: 587,
        imapHost: `mail.${state.domain}`,
        imapPort: 993,
      }
    : undefined;

  return {
    active: isActive,
    serverId: state.serverId,
    domain: state.domain,
    currentStep: runningStep ?? deriveCurrentStep(state),
    startedAt: Date.parse(state.startedAt),
    finishedAt: state.finishedAt ? Date.parse(state.finishedAt) : undefined,
    dnsRecords: state.dnsRecords ?? undefined,
    dnsAcknowledged: state.dnsAcknowledged,
    ptrAcknowledged: state.ptrAcknowledged ?? false,
    credentials,
    webmail,
    steps: stepStatuses,
    // Persisted log buffer - capped to MAX_PERSISTED_LOGS lines. Lets the
    // dashboard restore the live-log panel on refresh instead of showing
    // "logs will stream once setup starts" after every reload.
    logs: state.logs ?? [],
    resumeStep: state.resumeStep ?? undefined,
    errorMessage: state.errorMessage ?? undefined,
  };
}

/**
 * Build the `ptr_pending` event payload from state. Pulls IPv4/IPv6 out
 * of the A/AAAA DNS records (step 11 detected and stored them there)
 * and pairs them with `mail.<domain>` as the PTR target.
 *
 * Returns null if there's no IPv4 to set PTR for - we don't gate on PTR
 * if we couldn't even detect the IP, since the user can't act on it.
 */
function buildPtrPayload(
  state: MailServerState,
  resumeStep: number,
): { ipv4: string; ipv6: string | null; target: string; resumeStep: number } | null {
  const records = (state.dnsRecords ?? {}) as Record<
    string,
    { type?: unknown; value?: unknown }
  >;
  const a = records["a"];
  const aaaa = records["aaaa"];
  const ipv4 =
    a && typeof a.value === "string" && a.type === "A" ? a.value : null;
  const ipv6 =
    aaaa && typeof aaaa.value === "string" && aaaa.type === "AAAA"
      ? aaaa.value
      : null;
  if (!ipv4) return null;
  return {
    ipv4,
    ipv6,
    target: `mail.${state.domain}`,
    resumeStep,
  };
}

/** Step ID we'd resume from on retry - first step missing or failed. */
function deriveCurrentStep(state: MailServerState): number {
  for (const step of MAIL_SETUP_STEPS) {
    const r = state.completedSteps[String(step.id)];
    if (!r || !r.success) return step.id;
  }
  return TOTAL_STEPS;
}

function activeRunningStep(state: MailServerState): number {
  return deriveCurrentStep(state);
}

// ─── Handlers ────────────────────────────────────────────────────────────────

/** GET /mail/steps - list all setup steps with metadata */
export async function getSteps(c: Context) {
  if (env.CLOUD_MODE) return c.json({ error: "Not available" }, 404);
  return c.json({ steps: MAIL_SETUP_STEPS, total: TOTAL_STEPS });
}

/**
 * GET /mail/status?serverId=… - render the on-server state file as a status.
 *
 * If `serverId` is missing, returns the "no install" shell so the welcome
 * form still works. If the server is unreachable or the state file is
 * missing, returns "no install" - same shell.
 */
export async function getStatus(c: Context) {
  if (env.CLOUD_MODE) return c.json({ error: "Not available" }, 404);

  const serverId = c.req.query("serverId");
  if (!serverId) {
    return c.json({ active: false, steps: MAIL_SETUP_STEPS });
  }

  // Primary gate: permission resolver (404 on deny).
  await permission.assert(getRequestContext(c), {
    resourceType: "mail_server",
    resourceId: serverId,
    action: "read",
  });
  const ctx = getRequestContext(c);
  // Org-scoped: refuse to leak setup state for servers outside the caller's org.
  if (!(await isServerInOrg(ctx, serverId))) {
    return c.json({ error: "Server not found" }, 404);
  }

  // The webmail is a project like any other, so its state comes from the DB —
  // resolved BEFORE the SSH probe and independent of it. An unreachable mail
  // server must not make a deployed webmail vanish from the page, and a
  // mid-build one still has to link to its logs.
  const mailRecord = await repos.mailServer.get(serverId).catch(() => undefined);
  const webmail = mailRecord?.domain
    ? await resolveWebmailSummary(ctx.organizationId, {
        serverId,
        domain: mailRecord.domain,
        webmailProjectId: mailRecord.webmailProjectId ?? null,
      }).catch(() => undefined)
    : undefined;

  try {
    // One connection answers both questions: what HAS been installed (the state
    // file) and what is actually there RIGHT NOW (the engine topology). The probe
    // is memoized per executor and only runs on a box that has a state file, so
    // this is two execs on a connection we were opening anyway — and it's what
    // lets the admin panel say "the engine is stopped, here's the fix" instead of
    // letting every tab discover it as a 409 of its own.
    const probed = await sshManager.withExecutor(serverId, async (executor) => {
      const found = await readState(executor);
      const engine = found ? await resolveMailEngine(executor).catch(() => null) : null;
      return { state: found, engine };
    });
    let state = probed.state;
    // Older state files (pre-IP-detection) don't carry A/AAAA records.
    // Backfill from the server's sshHost so the DNS banner doesn't have
    // a hole where the host records should be.
    if (state) {
      state = await augmentStateWithHostRecords(state, serverId);
    }
    return c.json({
      ...statusFromState(state, serverId, webmail),
      // OMITTED, never nulled, when the probe couldn't conclude: absence means
      // "we didn't look", and the dashboard banner must never claim an engine is
      // missing off a failed read.
      ...(probed.engine
        ? { engine: { flavor: probed.engine.flavor, running: probed.engine.running } }
        : {}),
    });
  } catch {
    // SSH unreachable - treat as no-state. The dashboard handles this
    // gracefully and shows the empty form.
    return c.json(statusFromState(null, serverId, webmail));
  }
}

/**
 * GET /mail/servers - list every server openship has provisioned (or is
 * provisioning) the mail stack on.
 *
 * Reads from the `mail_servers` table - the single source of truth in
 * openship's DB. Fast (one query, no SSH), survives unreachable hosts,
 * and stays consistent with the install lifecycle (rows inserted on
 * install start, stamped on completion, removed on reset).
 *
 * Backfill: if the table is empty, we one-time SSH-scan all servers for
 * `mail-state.json` files written by older installs that predate this
 * table, and import them. After the first /emails load post-upgrade,
 * subsequent loads are pure DB reads.
 *
 * Result shape per row:
 *   { id, name, host, port, user, domain, completed, active }
 *
 *   - `completed` = `installedAt` is set on the mail_servers row
 *   - `active`    = an install is currently running against this server
 *                   in THIS API process (in-memory flag)
 */
export async function listMailServers(c: Context) {
  if (env.CLOUD_MODE) return c.json({ servers: [] });

  const ctx = getRequestContext(c);
  const organizationId = ctx.organizationId;

  let mailRows = await repos.mailServer.list();

  // Backfill from on-disk mail-state.json. Only runs when the table is
  // empty - otherwise the table is canonical and we never SSH-scan again.
  // Backfill is scoped to the caller's org (plus NULL-org rows) so we
  // don't import other tenants' rows.
  if (mailRows.length === 0) {
    const all = await repos.server.listByOrganization(organizationId);
    const scanned = await Promise.all(
      all.map(async (s) => {
        try {
          const state = await sshManager.withExecutor(s.id, (exec) => readState(exec));
          if (!state?.domain) return null;
          const completed =
            MAIL_SETUP_STEPS.length > 0 &&
            MAIL_SETUP_STEPS.every(
              (step) => state.completedSteps[String(step.id)]?.success === true,
            );
          return { serverId: s.id, domain: state.domain, completed };
        } catch {
          return null;
        }
      }),
    );
    for (const found of scanned) {
      if (!found) continue;
      try {
        await repos.mailServer.upsert({
          serverId: found.serverId,
          domain: found.domain,
          installedAt: found.completed ? new Date() : null,
        });
      } catch (err) {
        console.warn(
          "[mail] backfill upsert failed:",
          safeErrorMessage(err),
        );
      }
    }
    mailRows = await repos.mailServer.list();
  }

  // Join with the org-scoped servers table to surface host/user/port for
  // the UI. The Map filter implicitly drops any mail_server row whose
  // underlying server is outside this org — that's the cross-tenant gate.
  const allServers = await repos.server.listByOrganization(organizationId);
  const serverById = new Map(allServers.map((s) => [s.id, s]));
  const out = mailRows
    .map((row) => {
      const s = serverById.get(row.serverId);
      if (!s) return null; // FK CASCADE should prevent this, but guard anyway
      // Where an incomplete install paused, if anywhere. The human label is
      // derived from the step id here (server side) so the list needn't fetch
      // per-server status or duplicate the step table on the client.
      const resumeStep = row.resumeStep ?? null;
      return {
        id: s.id,
        name: s.name || s.sshHost,
        host: s.sshHost,
        port: s.sshPort ?? 22,
        user: s.sshUser ?? "root",
        domain: row.domain,
        completed: row.installedAt !== null,
        active: active?.serverId === s.id,
        resumeStep,
        resumeStepLabel: resumeStep
          ? MAIL_SETUP_STEPS[resumeStep - 1]?.label ?? null
          : null,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  return c.json({ servers: out });
}

/**
 * POST /mail/scan  { serverId }
 *
 * Probe a server for an EXISTING mail install whose orchestrator state was lost
 * (e.g. the desktop was rebuilt). Read-only — detects iRedMail (postfix +
 * dovecot active) and reads the on-server state file, so the user can re-adopt
 * a server they already set up instead of reinstalling.
 */
export async function scanMailInstall(c: Context) {
  if (env.CLOUD_MODE) return c.json({ error: "Not available" }, 404);

  const { serverId } = await c.req.json<{ serverId?: string }>();
  if (!serverId) return c.json({ error: "serverId is required" }, 400);

  await permission.assert(getRequestContext(c), {
    resourceType: "mail_server",
    resourceId: serverId,
    action: "write",
  });
  const ctx = getRequestContext(c);
  if (!(await isServerInOrg(ctx, serverId))) {
    return c.json({ error: "Server not found" }, 404);
  }

  try {
    const { iredmailInstalled, state } = await sshManager.withExecutor(
      serverId,
      async (exec) => ({
        iredmailInstalled: await mailIsServing(exec),
        state: await readState(exec),
      }),
    );
    const installComplete =
      !!state &&
      MAIL_SETUP_STEPS.length > 0 &&
      MAIL_SETUP_STEPS.every(
        (step) => state.completedSteps[String(step.id)]?.success === true,
      );
    // Informational: does openship already manage a webmail for this server?
    // Read from the DB, since the webmail is a project — a re-adopted box whose
    // openship DB was rebuilt correctly reads "not deployed": the container may
    // still be running, but nothing here manages or can redeploy it.
    const mailRecord = await repos.mailServer.get(serverId).catch(() => undefined);
    const webmailProject = await resolveLinkedWebmailProject(
      ctx.organizationId,
      serverId,
      mailRecord?.webmailProjectId ?? null,
    ).catch(() => null);
    return c.json({
      serverId,
      iredmailInstalled,
      hasState: !!state,
      domain: state?.domain ?? null,
      installComplete,
      webmailPresent: !!webmailProject,
      // Something to adopt iff a live stack OR a state file with a domain exists.
      adoptable: iredmailInstalled || !!state?.domain,
    });
  } catch (err) {
    return c.json({ error: `Scan failed: ${safeErrorMessage(err)}` }, 502);
  }
}

/**
 * POST /mail/adopt  { serverId }
 *
 * Re-adopt an existing mail server detected by /mail/scan: upsert the
 * `mail_servers` row from the on-server state so the dashboard manages it
 * again. Idempotent — no reinstall, nothing changes on the server.
 */
export async function adoptMailServer(c: Context) {
  if (env.CLOUD_MODE) return c.json({ error: "Not available" }, 404);

  const { serverId } = await c.req.json<{ serverId?: string }>();
  if (!serverId) return c.json({ error: "serverId is required" }, 400);

  await permission.assert(getRequestContext(c), {
    resourceType: "mail_server",
    resourceId: serverId,
    action: "write",
  });
  const ctx = getRequestContext(c);
  if (!(await isServerInOrg(ctx, serverId))) {
    return c.json({ error: "Server not found" }, 404);
  }

  try {
    const { iredmailInstalled, state } = await sshManager.withExecutor(
      serverId,
      async (exec) => ({
        iredmailInstalled: await mailIsServing(exec),
        state: await readState(exec),
      }),
    );
    const domain = state?.domain;
    if (!domain) {
      return c.json(
        {
          error: iredmailInstalled
            ? "A mail stack is running but no Openship state file was found — re-run setup to manage it."
            : "No mail server found on this server.",
        },
        404,
      );
    }
    const installComplete =
      MAIL_SETUP_STEPS.length > 0 &&
      MAIL_SETUP_STEPS.every(
        (step) => state.completedSteps[String(step.id)]?.success === true,
      );
    // Mark it installed when the stack is actually LIVE, not only when every
    // current step id is recorded success. An adopted server set up by an
    // older openship (or with step-id drift) has a running iRedMail stack but
    // may not satisfy the exact per-step check — treating it as installed keeps
    // the dashboard on the admin panel instead of bouncing to the setup wizard.
    const completed = iredmailInstalled || installComplete;
    await repos.mailServer.upsert({
      serverId,
      domain,
      installedAt: completed ? new Date() : null,
    });
    return c.json({ success: true, serverId, domain, completed });
  } catch (err) {
    return c.json({ error: `Adopt failed: ${safeErrorMessage(err)}` }, 502);
  }
}

/**
 * If the state file's `dnsRecords` is missing the `a` (and optionally
 * `aaaa`) entries, derive them from openship's stored sshHost - either
 * it's already an IP literal, or it's a hostname we resolve via DNS.
 *
 * This is a read-time augmentation only: we DON'T write back to the
 * state file. The compute is cheap (an OS-level DNS lookup, or a
 * regex check if sshHost is already an IP), and writing-on-read has
 * surprising side effects we'd rather avoid.
 */
async function augmentStateWithHostRecords(
  state: MailServerState,
  serverId: string,
): Promise<MailServerState> {
  if (!state.dnsRecords) return state;
  const records = state.dnsRecords as Record<string, unknown>;
  if (records.a) return state; // already present

  let server;
  try {
    server = await repos.server.get(serverId);
  } catch {
    return state;
  }
  if (!server?.sshHost) return state;

  const { ipv4, ipv6 } = await resolveHostIPs(server.sshHost);
  if (!ipv4) return state;

  const mailDomain = `mail.${state.domain}`;
  const augmented: Record<string, unknown> = {
    a: { type: "A", name: mailDomain, value: ipv4, required: true },
    ...(ipv6 && {
      aaaa: {
        type: "AAAA",
        name: mailDomain,
        value: ipv6,
        required: false,
      },
    }),
    ...records,
  };

  return { ...state, dnsRecords: augmented };
}

const IPV4_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * Resolve a host (IP literal or hostname) to its IPv4 and IPv6
 * addresses. Uses Node's OS-level DNS resolver - fast, no SSH needed.
 *
 * sshHost is typically the VPS's public IP (Hostinger / DO / etc.
 * provision IPs and surface them directly). Sometimes it's a hostname
 * like `srv1144965.hstgr.cloud`; either way, this returns the same
 * address the rest of the world would resolve.
 */
async function resolveHostIPs(
  host: string,
): Promise<{ ipv4: string | null; ipv6: string | null }> {
  // Already an IP - no resolution needed.
  if (IPV4_LITERAL.test(host)) {
    return { ipv4: host, ipv6: null };
  }
  if (host.includes(":") && /^[0-9a-f:]+$/i.test(host)) {
    return { ipv4: null, ipv6: host };
  }

  // Hostname - resolve both families independently. allSettled so a
  // missing AAAA doesn't kill the whole lookup.
  const [v4, v6] = await Promise.allSettled([
    dnsLookup(host, { family: 4 }),
    dnsLookup(host, { family: 6 }),
  ]);
  return {
    ipv4: v4.status === "fulfilled" ? v4.value.address : null,
    ipv6: v6.status === "fulfilled" ? v6.value.address : null,
  };
}

/**
 * A mail password travels to the box as one record in a line-delimited env-file
 * and gets templated into the engine image's first-boot configs. A control
 * character would break out of its record; the rest is defensive bounding.
 *
 * Mirrors the CR/LF rejection the relay credentials already do (see
 * admin/outbound-relay.service.ts) — same reasoning, same class of sink.
 */
export function mailPasswordError(password: string, label = "Password"): string | null {
  if (password.length < 12) return `${label} must be at least 12 characters`;
  if (password.length > 128) return `${label} must be at most 128 characters`;
  // Control characters (incl. CR/LF) would break out of the env-file record.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(password)) {
    return `${label} must be a single line without control characters`;
  }
  return null;
}

/** Validate the caller-supplied `config` on POST /mail/setup. Null when fine. */
function validateSetupConfig(config: IRedMailConfig | undefined): string | null {
  if (!config) return null;
  if (config.adminPassword !== undefined) {
    if (typeof config.adminPassword !== "string") {
      return "Admin password must be a string";
    }
    const err = mailPasswordError(config.adminPassword, "Admin password");
    if (err) return err;
  }
  if (
    config.storageBackend !== undefined &&
    config.storageBackend !== "postgresql" &&
    config.storageBackend !== "mariadb"
  ) {
    return 'config.storageBackend must be "postgresql" or "mariadb"';
  }
  return null;
}

/**
 * POST /mail/setup - start (or resume) the mail setup wizard.
 *
 * Body: { serverId: string, domain: string, startStep?: number, config?: IRedMailConfig }
 *
 * Returns an SSE stream with events:
 *   - step_start    { stepId, key, label }
 *   - log           { stepId, level, message }
 *   - step_done     { stepId, success, message, warning?, data? }
 *   - dns_records   { records }
 *   - dns_pending   { records, resumeStep }   - DKIM hold gate
 *   - ptr_pending   { ipv4, ipv6, target, resumeStep }   - VPS-provider PTR gate (after DNS ack)
 *   - complete      { success, domain, finishedAt }
 *   - error         { message, resumeStep? }
 */
export async function startSetup(c: Context) {
  if (env.CLOUD_MODE) return c.json({ error: "Not available" }, 404);

  const body = await c.req.json().catch(() => ({}));
  const serverId = body.serverId as string | undefined;
  const domain = body.domain as string | undefined;
  const startStep = Math.max(1, Math.min(TOTAL_STEPS, Number(body.startStep) || 1));
  const config = body.config as IRedMailConfig | undefined;

  if (!serverId) {
    return c.json({ error: "serverId is required" }, 400);
  }
  if (!domain || !/^[a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(domain)) {
    return c.json({ error: "Invalid domain" }, 400);
  }
  // `config` is a bare cast off the request body, so validate the fields that
  // travel to the box. adminPassword becomes a record in the engine's env-file
  // (see writeEnvFile) and is templated into the image's first-boot configs — a
  // control character there injects further environment records. The writer
  // rejects that too; this is the boundary layer so the caller gets a 400 rather
  // than a mid-stream step failure.
  const configError = validateSetupConfig(config);
  if (configError) {
    return c.json({ error: configError }, 400);
  }

  // Primary gate: starting/resuming setup is a write (mutates server state).
  await permission.assert(getRequestContext(c), {
    resourceType: "mail_server",
    resourceId: serverId,
    action: "write",
  });
  const ctx = getRequestContext(c);
  // Org-scoped: refuse to drive an iRedMail install on a server outside
  // the caller's org — this is full root-level reach into the box.
  if (!(await isServerInOrg(ctx, serverId))) {
    return c.json({ error: "Server not found" }, 404);
  }

  if (active) {
    return c.json({ error: "Setup already running" }, 409);
  }

  // Everything below this line answers with a 200: the response body IS the SSE
  // stream. So "we couldn't even start" has to be decided here — see
  // mail-setup-preflight (#492).
  const preflight = await preflightMailSetup(serverId);
  if (preflight) {
    return c.json({ error: preflight.error, code: preflight.code }, 502);
  }

  // Reserve the process-local slot before the first database await so two
  // requests cannot both pass the in-memory check in the same event-loop turn.
  const session: ActiveSession = { serverId, domain, cancelled: false };
  active = session;

  let reservation;
  try {
    reservation = await reserveMailSetup(serverId, domain);
  } catch (err) {
    if (active === session) active = null;
    console.error(
      "[mail] failed to reserve mail-server setup:",
      safeErrorMessage(err),
    );
    return c.json(
      { error: "Could not reserve mail setup. Please try again." },
      503,
    );
  }

  if (!reservation) {
    if (active === session) active = null;
    return c.json({ error: "Setup already running on another replica" }, 409);
  }

  const runSetup = async (stream: SSEStreamingApi) => {
    /**
     * The step every `error` frame is attributed to. A failure that happens
     * around the loop — reading state, persisting it, an executor that dies —
     * used to be reported with no step at all, so the wizard had nothing to mark
     * failed and fell back to its empty form (#492). Pinning it to the step we
     * were about to run (or are running) gives the step UI somewhere to put it.
     */
    let atStep = startStep;
    const fail = async (message: string, extra: Record<string, unknown> = {}) => {
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({ message, stepId: atStep, ...extra }),
      });
    };

    // Resolve initial state from the server. New install → fresh state.
    // Existing install on same domain → merge so secrets/completedSteps
    // survive across retries. Different domain on same server → wipe and
    // start over (we don't support two domains per server).
    let state: MailServerState;
    try {
      const existing = await sshManager.withExecutor(serverId, (executor) =>
        readState(executor),
      );
      if (existing && existing.domain === domain) {
        state = {
          ...existing,
          finishedAt: null,
          resumeStep: null,
          errorMessage: null,
        };
      } else {
        state = makeFreshState(serverId, domain);
      }
    } catch (err) {
      await fail(
        `Could not read state from server: ${err instanceof Error ? err.message : "ssh error"}`,
      );
      active = null;
      return;
    }

    // Older state files (pre-log-persistence) may not have `logs`. Normalise
    // here so subsequent code can treat `state.logs` as a mutable array
    // without `?? []` everywhere.
    if (!state.logs) {
      state = { ...state, logs: [] };
    }

    const log: StepLogger = (stepId, level, message) => {
      // Append to the persisted buffer + push to the live SSE listener.
      // appendLog caps the array at MAX_PERSISTED_LOGS - older lines fall
      // off the front. The write to disk happens at step boundaries via
      // `persist()`, not on every log line.
      if (state.logs) {
        appendLog(state.logs, stepId, level, message);
      }
      stream
        .writeSSE({ event: "log", data: JSON.stringify({ stepId, level, message }) })
        .catch(() => {});
    };

    /**
     * Persist current state to the server. Called at every step boundary so a
     * crash mid-run leaves the JSON pointing at the last completed step.
     */
    const persist = async () => {
      await sshManager.withExecutor(serverId, (executor) =>
        writeState(executor, state),
      );
    };

    /** Halt-and-persist: marks run as not-running, optionally with a resume hint. */
    const halt = async (extra: Partial<MailServerState>) => {
      state = { ...state, finishedAt: extra.finishedAt ?? null, ...extra };
      await persist();
      active = null;
      // Mirror the paused step onto the registry row so the /emails server list
      // can show WHERE an incomplete install stopped without an SSH probe (the
      // whole point of that table). A tracking write: never let it fail the
      // stream — same posture as markInstalled below.
      await repos.mailServer
        .setResumeStep(serverId, state.resumeStep ?? null)
        .catch((err) =>
          console.warn("[mail] setResumeStep failed:", safeErrorMessage(err)),
        );
    };

    try {
      // Write the initial state so the dashboard's getStatus sees us
      // as in-progress immediately, not "pending".
      await persist();

      // ── PTR gate ──────────────────────────────────────────────────
      //
      // Runs BEFORE the loop, so it fires when the user resumes from step 7+
      // (request_ssl) with DNS acknowledged but PTR not yet. The flow is:
      //   1. Step 6 (dkim_keys) emits dns_pending → user clicks "I've set DNS" →
      //      ack endpoint flips dnsAcknowledged → resume with startStep=7
      //   2. Pre-loop check below: dnsAck=true, ptrAck=false → emit
      //      ptr_pending → halt
      //   3. User clicks "I've set PTRs" → ack flips ptrAck → resume with
      //      startStep=7 → pre-loop check passes → loop runs request_ssl
      //
      // The `startStep > 6` guard prevents the gate from firing when the user
      // resumes from an earlier step — the loop re-runs dkim_keys and re-issues
      // dns_pending, which is the right order.
      if (
        startStep > 6 &&
        state.dnsRecords &&
        state.dnsAcknowledged &&
        !state.ptrAcknowledged
      ) {
        const ptrPayload = buildPtrPayload(state, startStep);
        if (ptrPayload) {
          await stream.writeSSE({
            event: "ptr_pending",
            data: JSON.stringify(ptrPayload),
          });
          await halt({ resumeStep: startStep, errorMessage: null });
          return;
        }
      }

      for (let stepId = startStep; stepId <= TOTAL_STEPS; stepId++) {
        atStep = stepId;
        if (active?.cancelled) {
          await fail("Setup cancelled by user");
          await halt({ resumeStep: stepId, errorMessage: "Setup cancelled by user" });
          return;
        }

        const stepDef = MAIL_SETUP_STEPS[stepId - 1];

        await stream.writeSSE({
          event: "step_start",
          data: JSON.stringify({ stepId, key: stepDef.key, label: stepDef.label }),
        });

        let result: StepResult;
        const runner = STEP_RUNNERS[stepId];
        const timeoutMs = STEP_TIMEOUT_MS[stepDef.key] ?? DEFAULT_STEP_TIMEOUT_MS;

        try {
          // Race the step against a per-step timeout. The underlying SSH
          // command keeps running on the server if it times out - we just
          // surface a failure here so the wizard isn't stuck staring at
          // silent output. The user can Retry (and on retry, the engine's
          // status file may show the work as already done).
          // Dev/from-source APPLY for the two steps that BRING UP a managed
          // container: build our source onto this box (or ship + build for a remote
          // one) before the installer runs, so its create/swap adopts the dev image
          // instead of pulling the published tag. No-op in prod (no checkout →
          // deliver returns at once).
          const deliverBefore = async (
            kind: "edge" | "mail",
            image: string,
            executor: CommandExecutor,
          ) => {
            await deliverManagedImage({
              kind,
              image,
              targetExecutor: executor,
              onLog: (l) => log(stepId, l.level, l.message),
            });
          };

          const runStep = (): Promise<StepResult> => {
            if (stepDef.key === "ensure_components") {
              return sshManager.withExecutor(serverId, async (executor) => {
                await deliverBefore("edge", pinnedEdgeImage(), executor);
                return (runner as BasicStepFn)(executor, domain, log);
              });
            }
            if (stepDef.key === "deploy_engine") {
              const installerConfig: IRedMailConfig = {
                ...config,
                prefillSecrets:
                  Object.keys(state.secrets).length > 0 ? state.secrets : undefined,
              };
              return sshManager.withExecutor(serverId, async (executor) => {
                await deliverBefore("mail", pinnedMailImage(), executor);
                return (runner as InstallerStepFn)(executor, domain, log, installerConfig);
              });
            }
            if (stepDef.key === "request_ssl") {
              // Issues through `platform.ssl`, which is resolved per SERVER — so
              // unlike every other step this one needs the server's identity, not
              // just an executor.
              return sshManager.withExecutor(serverId, (executor) =>
                (runner as SslStepFn)(executor, domain, log, {
                  serverId,
                  organizationId: ctx.organizationId,
                }),
              );
            }
            return sshManager.withExecutor(serverId, (executor) =>
              (runner as BasicStepFn)(executor, domain, log),
            );
          };

          result = await Promise.race([
            runStep(),
            new Promise<StepResult>((_, reject) =>
              setTimeout(
                () =>
                  reject(
                    new Error(
                      `Step "${stepDef.label}" timed out after ${Math.round(timeoutMs / 60_000)} min`,
                    ),
                  ),
                timeoutMs,
              ),
            ),
          ]);
        } catch (err) {
          const message = err instanceof Error ? err.message : "Step execution failed";
          result = { stepId, success: false, message };
          log(stepId, "error", message);
        }

        state = recordStep(state, {
          stepId: result.stepId,
          success: result.success,
          message: result.message,
          warning: result.warning,
          data: result.data,
        });

        // The deploy step returns generated DB passwords - persist so a re-run
        // reuses the same values the engine's first boot wrote into its configs.
        if (stepDef.key === "deploy_engine" && result.data?.secrets) {
          state = mergeSecrets(state, result.data.secrets as Record<string, string>);
        }

        // ...and which engine image + container it brought up, so the dashboard can
        // show the running version and the next deploy's swap compares against the
        // real ref rather than re-deriving it.
        if (stepDef.key === "deploy_engine" && result.data?.engine) {
          const engine = result.data.engine as { image?: string; container?: string };
          state = {
            ...state,
            ...(engine.image ? { engineImage: engine.image } : {}),
            ...(engine.container ? { containerName: engine.container } : {}),
          };
        }

        await stream.writeSSE({
          event: "step_done",
          data: JSON.stringify(result),
        });

        // DKIM step: broadcast records + hold-and-continue gate
        if (stepDef.key === "dkim_keys" && result.success && result.data?.dnsRecords) {
          state = {
            ...state,
            dnsRecords: result.data.dnsRecords as Record<string, unknown>,
          };
          // stepDkimKeys rebuilds dnsRecords SELF-HOST-ONLY. If an SES outbound
          // relay is active, re-lay its send-hop records (SPF include + SES
          // DKIM/MAIL FROM) back on — otherwise a re-install / resume silently
          // drops them and SES sending breaks / DMARC misaligns.
          if (state.outboundRelay?.enabled) {
            state = { ...state, ...applyRelayToState(state, state.outboundRelay) };
          }
          await stream.writeSSE({
            event: "dns_records",
            data: JSON.stringify({ records: state.dnsRecords }),
          });

          if (!state.dnsAcknowledged) {
            await stream.writeSSE({
              event: "dns_pending",
              data: JSON.stringify({
                records: state.dnsRecords,
                resumeStep: stepId + 1,
              }),
            });
            await halt({ resumeStep: stepId + 1, errorMessage: null });
            return;
          }
        }

        if (!result.success) {
          await fail(result.message, { resumeStep: stepId });
          await halt({ resumeStep: stepId, errorMessage: result.message });
          return;
        }

        // Persist after every successful step so a crash leaves a coherent file.
        await persist();
      }

      const finishedAt = new Date().toISOString();
      await halt({ resumeStep: null, errorMessage: null, finishedAt });

      // Stamp installedAt now that the wizard hit its terminal success state.
      // This is what flips the row from "in-progress" to "installed" for the
      // /emails dashboard. Wrapped in try/catch - the install itself
      // succeeded; a DB write failure here is a tracking issue, not a
      // user-visible failure.
      try {
        await repos.mailServer.markInstalled(serverId, domain);
      } catch (err) {
        console.warn(
          "[mail] failed to stamp installedAt on mail-server record:",
          safeErrorMessage(err),
        );
      }

      // Best-effort: provision the platform SMTP mailbox the API uses to send
      // transactional mail (welcome emails, alerts, future user-invite sends).
      // Same try/catch shape as markInstalled — a hiccup here must not poison
      // the wizard's terminal success state; the operator (or the first
      // sendTestEmail call) will trigger ensureOpenshipPlatformMailbox again
      // later via its on-demand backfill path.
      //
      // Dynamic import mirrors the pattern domains.service.ts uses to dodge a
      // load-time cycle (mail-state ↔ mail.controller ↔ admin services).
      try {
        const { ensureOpenshipPlatformMailbox } = await import(
          "./admin/platform-mailbox.service"
        );
        // Clear any cached "platform mailbox unavailable" marker from BEFORE the
        // install finished — otherwise the send path keeps skipping this server
        // for the rest of the failure window right after a successful install.
        invalidatePlatformTransport(serverId);
        const creds = await ensureOpenshipPlatformMailbox(serverId);
        await stream.writeSSE({
          event: "log",
          data: JSON.stringify({
            level: "info",
            message: `Provisioned platform mailbox ${creds.email} (smtp ${creds.smtpHost}:${creds.smtpPort}).`,
          }),
        });
      } catch (err) {
        console.warn(
          `[mail.install] ensureOpenshipPlatformMailbox failed for ${serverId}:`,
          err,
        );
        await stream.writeSSE({
          event: "log",
          data: JSON.stringify({
            level: "warn",
            message: `Platform mailbox provisioning failed (non-fatal): ${safeErrorMessage(err)}. Retry from the Admin → Mailboxes panel.`,
          }),
        });
      }

      await stream.writeSSE({
        event: "complete",
        data: JSON.stringify({
          success: true,
          domain,
          mailDomain: `mail.${domain}`,
          finishedAt: Date.parse(finishedAt),
          webmailUrl: `https://mail.${domain}/mail`,
          adminUrl: `https://mail.${domain}/iredadmin`,
        }),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Setup failed";
      await fail(message);
      try {
        await halt({ errorMessage: message });
      } catch {
        active = null;
      }
    }
  };

  const releaseSession = async () => {
    if (active === session) active = null;
    await reservation.release();
  };

  try {
    return streamSSE(c, async (stream) => {
      try {
        await runSetup(stream);
      } finally {
        await releaseSession();
      }
    });
  } catch (err) {
    await releaseSession();
    throw err;
  }
}

/** POST /mail/setup/cancel - cancel the running setup */
export async function cancelSetup(c: Context) {
  if (env.CLOUD_MODE) return c.json({ error: "Not available" }, 404);

  if (!active) {
    return c.json({ error: "No active setup" }, 400);
  }

  // Primary gate: cancelling a running install is a state mutation (write).
  await permission.assert(getRequestContext(c), {
    resourceType: "mail_server",
    resourceId: active.serverId,
    action: "write",
  });
  const ctx = getRequestContext(c);
  // Org-scoped: only the org that owns the target server can cancel its
  // setup. 404-shape on cross-org so existence of the install doesn't
  // leak.
  if (!(await isServerInOrg(ctx, active.serverId))) {
    return c.json({ error: "Server not found" }, 404);
  }

  active.cancelled = true;
  return c.json({ ok: true, message: "Cancellation requested" });
}

/**
 * POST /mail/setup/dns-ack - mark DNS records as configured on a session.
 *
 * Body: { serverId: string }
 *
 * Flips `dnsAcknowledged` in the on-server state file. The dashboard then
 * re-POSTs to /mail/setup with `startStep = resumeStep` to resume past
 * the DKIM hold.
 */
export async function acknowledgeDns(c: Context) {
  if (env.CLOUD_MODE) return c.json({ error: "Not available" }, 404);

  const body = await c.req.json().catch(() => ({}));
  const serverId = body.serverId as string | undefined;
  if (!serverId) return c.json({ error: "serverId is required" }, 400);

  // Primary gate: ack flips a bit in the on-server state file (write).
  await permission.assert(getRequestContext(c), {
    resourceType: "mail_server",
    resourceId: serverId,
    action: "write",
  });
  const ctx = getRequestContext(c);
  if (!(await isServerInOrg(ctx, serverId))) {
    return c.json({ error: "Server not found" }, 404);
  }

  try {
    await sshManager.withExecutor(serverId, async (executor) => {
      const result = await mutateState(executor, serverId, (s) => ({ ...s, dnsAcknowledged: true }));
      if (!result) {
        throw new Error("No setup state on this server");
      }
    });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "DNS acknowledge failed" },
      400,
    );
  }
  return c.json({ ok: true });
}

/**
 * POST /mail/setup/ptr-ack - mark reverse-DNS (PTR) as configured.
 *
 * Body: { serverId: string }
 *
 * Same shape as the DNS ack - flips a bit on the on-server state file,
 * then the dashboard re-POSTs to /mail/setup with the resume step to
 * continue past the PTR gate.
 *
 * We deliberately don't verify the PTR with `dig -x` from openship's host:
 * many VPS providers (Hostinger included) take 5-15 minutes to propagate
 * rDNS changes, and blocking on that would frustrate users. If they lie
 * about having set it, mail-to-Gmail just goes to spam - recoverable.
 */
export async function acknowledgePtr(c: Context) {
  if (env.CLOUD_MODE) return c.json({ error: "Not available" }, 404);

  const body = await c.req.json().catch(() => ({}));
  const serverId = body.serverId as string | undefined;
  if (!serverId) return c.json({ error: "serverId is required" }, 400);

  // Primary gate: ack flips a bit in the on-server state file (write).
  await permission.assert(getRequestContext(c), {
    resourceType: "mail_server",
    resourceId: serverId,
    action: "write",
  });
  const ctx = getRequestContext(c);
  if (!(await isServerInOrg(ctx, serverId))) {
    return c.json({ error: "Server not found" }, 404);
  }

  try {
    await sshManager.withExecutor(serverId, async (executor) => {
      const result = await mutateState(executor, serverId, (s) => ({ ...s, ptrAcknowledged: true }));
      if (!result) {
        throw new Error("No setup state on this server");
      }
    });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "PTR acknowledge failed" },
      400,
    );
  }
  return c.json({ ok: true });
}

/**
 * POST /mail/setup/reset - wipe the state file on the target server.
 *
 * Body: { serverId: string }
 *
 * Useful after the operator has purged or reimaged the VPS - clears any
 * stale state without manually SSHing to delete the JSON. Does NOT touch
 * iRedMail or any installed daemons; just removes openship's record.
 */
export async function resetSetup(c: Context) {
  if (env.CLOUD_MODE) return c.json({ error: "Not available" }, 404);

  const body = await c.req.json().catch(() => ({}));
  const serverId = body.serverId as string | undefined;
  if (!serverId) return c.json({ error: "serverId is required" }, 400);

  // Primary gate: wiping the mail-state file is destructive (admin).
  await permission.assert(getRequestContext(c), {
    resourceType: "mail_server",
    resourceId: serverId,
    action: "admin",
  });
  const ctx = getRequestContext(c);
  if (!(await isServerInOrg(ctx, serverId))) {
    return c.json({ error: "Server not found" }, 404);
  }

  if (active?.serverId === serverId) {
    return c.json({ error: "Cancel the running setup first" }, 409);
  }

  try {
    await sshManager.withExecutor(serverId, (executor) => clearState(executor));
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Reset failed" },
      500,
    );
  }
  // Drop openship's record of "this server is a mail server" the moment the
  // on-host state file goes. Best-effort - losing the row is recoverable on
  // the next install start, but losing them out of sync would let /emails
  // claim a stale mail server.
  try {
    await repos.mailServer.remove(serverId);
  } catch (err) {
    console.warn(
      "[mail] failed to drop mail-server record after reset:",
      safeErrorMessage(err),
    );
  }
  return c.json({ ok: true });
}

/**
 * DELETE /mail/servers/:serverId - stop managing a mail server.
 *
 * Drops ONLY the `mail_servers` DB row so /emails stops listing it.
 * Deliberately does NOT SSH to the box: the mail stack keeps running and
 * the on-server state file (`mail-state.json`) is left intact, so the
 * server can be re-adopted later via the scan + adopt flow (which requires
 * that state file's domain). This is the non-destructive sibling of
 * resetSetup, for clearing a stale/corrupted registry mark.
 */
export async function forgetMailServer(c: Context) {
  if (env.CLOUD_MODE) return c.json({ error: "Not available" }, 404);

  const serverId = c.req.param("serverId");
  if (!serverId) return c.json({ error: "serverId is required" }, 400);

  await permission.assert(getRequestContext(c), {
    resourceType: "mail_server",
    resourceId: serverId,
    action: "admin",
  });
  const ctx = getRequestContext(c);
  if (!(await isServerInOrg(ctx, serverId))) {
    return c.json({ error: "Server not found" }, 404);
  }

  // Don't detach a row out from under a running install - startSetup
  // re-upserts it and the UI would flap.
  if (active?.serverId === serverId) {
    return c.json({ error: "Cancel the running setup first" }, 409);
  }

  await repos.mailServer.remove(serverId);
  return c.json({ ok: true });
}

// ─── Backup (plugs the mail server into the general backup system) ───────────

/** GET /mail/admin/:serverId/backup-policy — the mail server's backup
 *  policy (or null), so the Backup tab can show its current config. */
export async function getMailBackupPolicy(c: Context) {
  if (env.CLOUD_MODE) return c.json({ error: "Not available" }, 404);
  const serverId = c.req.param("serverId");
  if (!serverId) return c.json({ error: "serverId is required" }, 400);
  const ctx = getRequestContext(c);
  await permission.assert(ctx, {
    resourceType: "mail_server",
    resourceId: serverId,
    action: "read",
  });
  if (!(await isServerInOrg(ctx, serverId))) {
    return c.json({ error: "Server not found" }, 404);
  }
  const policy = await repos.backupPolicy.findActiveByMailServer(serverId);
  return c.json({ policy: policy ?? null });
}

/** POST /mail/admin/:serverId/backup-policy — create or update the mail
 *  server's backup policy. Body: { destinationId, messageData?, keys?,
 *  cronExpression?, retainCount?, retainDays? }.
 *
 *  Retention follows the project-policy convention: omitted keeps the stored
 *  value (or defaults ON when creating), explicit null means unlimited. An
 *  invalid `cronExpression` is a 400 rather than a silently dead schedule. */
export async function saveMailBackupPolicy(c: Context) {
  if (env.CLOUD_MODE) return c.json({ error: "Not available" }, 404);
  const serverId = c.req.param("serverId");
  if (!serverId) return c.json({ error: "serverId is required" }, 400);
  const ctx = getRequestContext(c);
  await permission.assert(ctx, {
    resourceType: "mail_server",
    resourceId: serverId,
    action: "admin",
  });
  if (!(await isServerInOrg(ctx, serverId))) {
    return c.json({ error: "Server not found" }, 404);
  }

  const mailRow = await repos.mailServer.get(serverId);
  if (!mailRow?.domain) {
    return c.json({ error: "Mail server is not registered / has no domain" }, 404);
  }

  const body = (await c.req.json().catch(() => ({}))) as {
    destinationId?: string;
    messageData?: boolean;
    keys?: boolean;
    cronExpression?: string | null;
    retainCount?: number | null;
    retainDays?: number | null;
  };
  if (!body.destinationId) {
    return c.json({ error: "destinationId is required" }, 400);
  }
  const destination = await repos.backupDestination.findById(body.destinationId);
  if (!destination || destination.organizationId !== ctx.organizationId) {
    return c.json({ error: "Destination not found" }, 404);
  }

  const messageData = body.messageData === true;
  const keys = body.keys !== false; // default: include keys/secrets
  const payload = buildMailBackupPayload(mailRow.domain, { messageData, keys });

  const cronExpression =
    typeof body.cronExpression === "string" && body.cronExpression.trim()
      ? body.cronExpression.trim()
      : null;
  // Rejected here rather than stored: `syncPolicySchedule` drops an unparseable
  // cron with nothing but a console warning, so an accepted-but-invalid schedule
  // shows as saved in the Backup tab and then never fires.
  if (cronExpression) {
    const check = validateCronExpression(cronExpression);
    if (!check.valid) {
      return c.json({ error: `Invalid schedule: ${check.reason ?? "unknown"}` }, 400);
    }
  }

  const existing = await repos.backupPolicy.findActiveByMailServer(serverId);

  // Omitted vs explicit-null, the same distinction `createPolicy` draws for
  // project policies (backup.service.ts) — and it has to be drawn here because
  // `shared` doubles as the update patch, so a blanket default would overwrite
  // whatever the operator set. Omitted on an existing policy keeps the stored
  // value; omitted on create turns retention ON, because two NULLs mean "keep
  // everything forever" to `prunePolicy` and a caller who never sent the field
  // did not ask for that. Explicit null still says unlimited. Only defaulted when
  // NEITHER field was sent: setting days alone is a deliberate choice, and adding
  // a count would silently tighten it.
  const retentionUnspecified =
    body.retainCount === undefined && body.retainDays === undefined;
  const retainCount = retentionUnspecified
    ? existing
      ? existing.retainCount
      : DEFAULT_RETAIN_COUNT
    : (body.retainCount ?? null);
  const retainDays = retentionUnspecified
    ? (existing?.retainDays ?? null)
    : (body.retainDays ?? null);

  const shared = {
    sourceKind: "mail_server" as const,
    mailServerId: serverId,
    projectId: null,
    serviceId: null,
    destinationId: body.destinationId,
    enabled: true,
    cronExpression,
    retainCount,
    retainDays,
    payloadKind: payload.payloadKind,
    payloadConfig: payload.payloadConfig,
  };

  const policy = existing
    ? await repos.backupPolicy.update(existing.id, { ...shared, updatedAt: new Date() })
    : await repos.backupPolicy.create({
        id: `bkp_${crypto.randomUUID()}`,
        createdBy: ctx.userId,
        ...shared,
      });

  if (!policy) {
    // The row was deleted between the read above and this write. Reporting the
    // save as successful would leave the tab showing a schedule that no longer
    // has a row, let alone a job.
    return c.json({ error: "Backup policy no longer exists" }, 409);
  }

  // Register/refresh the recurring job (a no-op when the schedule is manual).
  // Without this the row said "daily" while no job existed, and the schedule only
  // came alive at the next API restart, when `reconcileAllSchedules()` swept it up.
  await syncPolicySchedule(policy.id);

  return c.json({ policy });
}

/** GET /mail/admin/:serverId/backup-runs — this mail server's backup runs. */
export async function listMailBackupRuns(c: Context) {
  if (env.CLOUD_MODE) return c.json({ error: "Not available" }, 404);
  const serverId = c.req.param("serverId");
  if (!serverId) return c.json({ error: "serverId is required" }, 400);
  const ctx = getRequestContext(c);
  await permission.assert(ctx, {
    resourceType: "mail_server",
    resourceId: serverId,
    action: "read",
  });
  if (!(await isServerInOrg(ctx, serverId))) {
    return c.json({ error: "Server not found" }, 404);
  }
  const runs = await repos.backupRun.listByOrganization(ctx.organizationId, {
    mailServerId: serverId,
    limit: 50,
  });
  return c.json({ runs });
}

/**
 * POST /mail/credentials/postmaster - rotate the postmaster password.
 *
 * Body: { serverId: string, password: string }
 *
 * Hashes via doveadm, UPDATEs `vmail.mailbox`, mirrors the cleartext into
 * the on-server state file so the dashboard's Credentials card refreshes
 * cleanly. Refuses if a setup is currently running against the same server
 * (would race with the installer's own writes to that row).
 */
export async function setPostmasterPassword(c: Context) {
  if (env.CLOUD_MODE) return c.json({ error: "Not available" }, 404);

  const body = await c.req.json().catch(() => ({}));
  const serverId = body.serverId as string | undefined;
  const password = body.password as string | undefined;

  if (!serverId) return c.json({ error: "serverId is required" }, 400);
  // Same validation as setup's adminPassword: this value is stored in the
  // server's mail-state and replayed into the engine env-file on the next
  // container bring-up, so a control character here would inject an env record
  // later (see writeEnvFile in ensure-container-mail.ts).
  if (typeof password !== "string") {
    return c.json({ error: "Password must be a string" }, 400);
  }
  const pwError = mailPasswordError(password);
  if (pwError) {
    return c.json({ error: pwError }, 400);
  }

  // Primary gate: rotating the postmaster password is destructive (admin).
  await permission.assert(getRequestContext(c), {
    resourceType: "mail_server",
    resourceId: serverId,
    action: "admin",
  });
  const ctx = getRequestContext(c);
  if (!(await isServerInOrg(ctx, serverId))) {
    return c.json({ error: "Server not found" }, 404);
  }

  if (active?.serverId === serverId) {
    return c.json(
      { error: "Setup is currently running - wait for it to finish" },
      409,
    );
  }

  try {
    await sshManager.withExecutor(serverId, async (executor) => {
      const state = await readState(executor);
      if (!state) throw new Error("No setup state on this server");
      await updatePostmasterPassword(executor, state.domain, password);
    });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Password change failed" },
      500,
    );
  }
  return c.json({ ok: true });
}

/**
 * GET /mail/health/:serverId - live status of every mail-core daemon, plus whether
 * mail is actually leaving the box.
 *
 * Used by the dashboard's Mail tab to show running/stopped pills next to
 * each component. Cheap: one short SSH per unit, all parallel.
 *
 * `delivery` rides this response rather than a route of its own because it answers
 * the same question at the same moment on the same connection, and the tab already
 * polls this every 10s — a second endpoint would double the SSH traffic to show two
 * halves of one verdict.
 */
export async function getHealth(c: Context) {
  if (env.CLOUD_MODE) return c.json({ error: "Not available" }, 404);

  const serverId = c.req.param("serverId");
  if (!serverId) return c.json({ error: "serverId is required" }, 400);

  // Primary gate: live daemon status is a read.
  await permission.assert(getRequestContext(c), {
    resourceType: "mail_server",
    resourceId: serverId,
    action: "read",
  });
  const ctx = getRequestContext(c);
  if (!(await isServerInOrg(ctx, serverId))) {
    return c.json({ error: "Server not found" }, 404);
  }

  try {
    const { components, delivery } = await sshManager.withExecutor(serverId, async (executor) => {
      // Both sweeps share the engine probe (memoized per executor), so running them
      // together costs one extra exec, not a second topology detection.
      const [components, delivery] = await Promise.all([
        checkMailHealth(executor),
        // `delivery` reports its own failures as `status: "unknown"` rather than
        // throwing, so a box whose queue we can't read still renders its daemons.
        checkMailDelivery(executor),
      ]);
      return { components, delivery };
    });
    return c.json({ serverId, components, definitions: MAIL_COMPONENTS, delivery });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Health check failed";
    return c.json({ error: message }, 500);
  }
}
