/**
 * Mail setup controller — exposes HTTP endpoints for the mail server
 * setup wizard.  Self-hosted only (gated with localOnly + authMiddleware).
 *
 * Endpoints:
 *   GET  /mail/steps             → list all setup steps
 *   GET  /mail/status            → current setup progress
 *   POST /mail/setup             → start or resume setup (SSE stream)
 *   POST /mail/setup/cancel      → cancel running setup
 *   POST /mail/ports/check       → standalone port 80/443 scan
 *   POST /mail/ports/resolve     → resolve a detected port conflict
 */

import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { env } from "../../config";
import { sshManager } from "../../lib/ssh-manager";
import {
  MAIL_SETUP_STEPS,
  TOTAL_STEPS,
  STEP_RUNNERS,
  type StepResult,
  type StepLogger,
  type BasicStepFn,
  type RebootStepFn,
  type InstallerStepFn,
  type IRedMailConfig,
} from "./mail.service";
import {
  detectPortConflicts,
  resolveConflict,
  type PortConflict,
} from "./port-manager";

// ─── In-memory session (single-tenant, self-hosted) ──────────────────────────

interface MailSetupSession {
  running: boolean;
  serverId: string;
  domain: string;
  currentStep: number;
  startedAt: number;
  completedSteps: Map<number, StepResult>;
  cancelled: boolean;
  finishedAt?: number;
  /** DNS records returned by step 11 (dkim_keys) */
  dnsRecords?: Record<string, unknown>;
}

let session: MailSetupSession | null = null;

// ─── Handlers ────────────────────────────────────────────────────────────────

/** GET /mail/steps — list all setup steps with metadata */
export async function getSteps(c: Context) {
  if (env.CLOUD_MODE) return c.json({ error: "Not available" }, 404);
  return c.json({ steps: MAIL_SETUP_STEPS, total: TOTAL_STEPS });
}

/** GET /mail/status — current setup status */
export async function getStatus(c: Context) {
  if (env.CLOUD_MODE) return c.json({ error: "Not available" }, 404);

  if (!session) {
    return c.json({ active: false, steps: MAIL_SETUP_STEPS });
  }

  const stepStatuses = MAIL_SETUP_STEPS.map((step) => {
    const result = session!.completedSteps.get(step.id);
    let status: "pending" | "running" | "completed" | "failed" | "skipped" = "pending";
    if (result?.success) status = "completed";
    else if (result && !result.success) status = "failed";
    else if (session!.running && session!.currentStep === step.id) status = "running";
    else if (result === undefined && step.id < session!.currentStep) status = "skipped";

    return {
      ...step,
      status,
      message: result?.message,
      warning: result?.warning,
      data: result?.data,
    };
  });

  return c.json({
    active: session.running,
    serverId: session.serverId,
    domain: session.domain,
    currentStep: session.currentStep,
    startedAt: session.startedAt,
    finishedAt: session.finishedAt,
    dnsRecords: session.dnsRecords,
    steps: stepStatuses,
  });
}

/**
 * POST /mail/setup — start (or resume) the mail setup wizard.
 *
 * Body: { serverId: string, domain: string, startStep?: number, config?: IRedMailConfig }
 *
 * Returns an SSE stream with events:
 *   - step_start    { stepId, key, label }
 *   - log           { stepId, level, message }
 *   - step_done     { stepId, success, message, warning?, data? }
 *   - port_conflict { portConflicts: PortConflict[] }
 *   - dns_records   { records }
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

  if (session?.running) {
    return c.json({ error: "Setup already running" }, 409);
  }

  // Initialize session
  session = {
    running: true,
    serverId,
    domain,
    currentStep: startStep,
    startedAt: Date.now(),
    completedSteps: new Map(),
    cancelled: false,
  };

  return streamSSE(c, async (stream) => {
    const log: StepLogger = (stepId, level, message) => {
      stream
        .writeSSE({ event: "log", data: JSON.stringify({ stepId, level, message }) })
        .catch(() => {});
    };

    try {
      for (let stepId = startStep; stepId <= TOTAL_STEPS; stepId++) {
        if (session?.cancelled) {
          await stream.writeSSE({
            event: "error",
            data: JSON.stringify({ message: "Setup cancelled by user" }),
          });
          break;
        }

        const stepDef = MAIL_SETUP_STEPS[stepId - 1];
        session!.currentStep = stepId;

        await stream.writeSSE({
          event: "step_start",
          data: JSON.stringify({ stepId, key: stepDef.key, label: stepDef.label }),
        });

        let result: StepResult;
        const runner = STEP_RUNNERS[stepId];

        try {
          // Key-based dispatch for steps with special signatures
          if (stepDef.key === "first_reboot" || stepDef.key === "configure_ssl") {
            const reconnectFn = async () => {
              sshManager.invalidate(serverId);
              return sshManager.acquire(serverId);
            };
            const executor = await sshManager.acquire(serverId);
            result = await (runner as RebootStepFn)(executor, domain, log, reconnectFn);
          } else if (stepDef.key === "run_installer") {
            result = await sshManager.withExecutor(serverId, (executor) =>
              (runner as InstallerStepFn)(executor, domain, log, config),
            );
          } else {
            result = await sshManager.withExecutor(serverId, (executor) =>
              (runner as BasicStepFn)(executor, domain, log),
            );
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : "Step execution failed";
          result = { stepId, success: false, message };
          log(stepId, "error", message);
        }

        session!.completedSteps.set(stepId, result);

        await stream.writeSSE({
          event: "step_done",
          data: JSON.stringify(result),
        });

        // Port conflict detection — send detailed conflict data to frontend
        if (stepDef.key === "check_web_ports" && !result.success && result.data?.portConflicts) {
          await stream.writeSSE({
            event: "port_conflict",
            data: JSON.stringify({ portConflicts: result.data.portConflicts }),
          });
          // Stop — user must resolve conflicts before continuing
          await stream.writeSSE({
            event: "error",
            data: JSON.stringify({
              message: result.message,
              resumeStep: stepId,
            }),
          });
          session!.running = false;
          session!.finishedAt = Date.now();
          return;
        }

        // DKIM keys — broadcast DNS records separately
        if (stepDef.key === "dkim_keys" && result.success && result.data?.dnsRecords) {
          session!.dnsRecords = result.data.dnsRecords as Record<string, unknown>;
          await stream.writeSSE({
            event: "dns_records",
            data: JSON.stringify({ records: result.data.dnsRecords }),
          });
        }

        if (!result.success) {
          await stream.writeSSE({
            event: "error",
            data: JSON.stringify({
              message: result.message,
              resumeStep: stepId,
            }),
          });
          session!.running = false;
          session!.finishedAt = Date.now();
          return;
        }
      }

      session!.running = false;
      session!.finishedAt = Date.now();

      await stream.writeSSE({
        event: "complete",
        data: JSON.stringify({
          success: true,
          domain,
          mailDomain: `mail.${domain}`,
          finishedAt: session!.finishedAt,
          webmailUrl: `https://mail.${domain}/mail`,
          adminUrl: `https://mail.${domain}/iredadmin`,
        }),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Setup failed";
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({ message }),
      });
      if (session) {
        session.running = false;
        session.finishedAt = Date.now();
      }
    }
  });
}

/** POST /mail/setup/cancel — cancel a running setup */
export async function cancelSetup(c: Context) {
  if (env.CLOUD_MODE) return c.json({ error: "Not available" }, 404);

  if (!session?.running) {
    return c.json({ error: "No active setup" }, 400);
  }

  session.cancelled = true;
  return c.json({ ok: true, message: "Cancellation requested" });
}

// ─── Port conflict endpoints ─────────────────────────────────────────────────

/** POST /mail/ports/check — standalone port scan for 80/443 */
export async function checkPorts(c: Context) {
  if (env.CLOUD_MODE) return c.json({ error: "Not available" }, 404);

  const body = await c.req.json().catch(() => ({}));
  const serverId = body.serverId as string | undefined;

  if (!serverId) {
    return c.json({ error: "serverId is required" }, 400);
  }

  try {
    const conflicts = await sshManager.withExecutor(serverId, (executor) =>
      detectPortConflicts(executor),
    );
    return c.json({ conflicts, free: conflicts.length === 0 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Port check failed";
    return c.json({ error: message }, 500);
  }
}

/**
 * POST /mail/ports/resolve — resolve a specific port conflict.
 *
 * Body: { serverId: string, conflict: PortConflict, resolutionId: string }
 */
export async function resolvePorts(c: Context) {
  if (env.CLOUD_MODE) return c.json({ error: "Not available" }, 404);

  const body = await c.req.json().catch(() => ({}));
  const serverId = body.serverId as string | undefined;
  const conflict = body.conflict as PortConflict | undefined;
  const resolutionId = body.resolutionId as string | undefined;

  if (!serverId || !conflict || !resolutionId) {
    return c.json({ error: "Missing serverId, conflict, or resolutionId" }, 400);
  }

  try {
    const result = await sshManager.withExecutor(serverId, (executor) =>
      resolveConflict(executor, conflict, resolutionId),
    );
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Resolution failed";
    return c.json({ error: message, success: false }, 500);
  }
}
