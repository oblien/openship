import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { reportCaughtError } from "@repo/core/diagnostics";
import {
  AppError,
  ValidationError,
  safeErrorMessage,
  type SecurityAdvisory,
  type SecurityHostTarget,
} from "@repo/core";
import { repos, tryAcquireAdvisoryLock, type Server } from "@repo/db";
import type { HostPatchPlan, ServerSecurityResult } from "@repo/contracts";
import type { CommandExecutor } from "@repo/adapters";
import type { ExecutionContext } from "../../../context";
import { env } from "../../config/env";
import { authorization } from "../../lib/authorization";
import { requireConnectedServer, assertServerExecution } from "../system/server-access";
import { isLocalHostRow } from "../../lib/box-org";
import { resolveHostControlEnabled } from "../../lib/host-control";
import { withServerExecution } from "../../lib/server-execution";
import { jobRunBus } from "../jobs/job-run.sse";
import { deferBackgroundWork } from "../../lib/background-work";
import { assertNativeJobs } from "../../native/execution-policy";
import { audit, operationAuditContext } from "../../lib/audit-emitter";
import { getAdvisoryFeed, type AdvisoryFeedState } from "./advisory-feed";
import { assertSecurityChecksEnabled } from "./security-check-policy";
import { nextSecurityInspection, securityObservationDue } from "./security-freshness";
import { HOST_SECURITY_SCRIPT } from "./host-security-script";

const text = z.string().max(300);
const rowSchema = z
  .object({
    key: text,
    package: text,
    installed: text.nullable(),
    candidate: text.nullable(),
    state: z.enum(["fixed", "affected", "reboot_required", "unknown"]),
    canPatch: z.boolean(),
    runningVersion: text.nullable(),
  })
  .strict();
const observationSchema = z
  .object({
    distribution: z.literal("ubuntu"),
    release: text,
    bootId: text,
    kernel: text,
    rebootRequired: z.boolean(),
    rows: z.array(rowSchema).max(200),
  })
  .strict();
const planSchema = z
  .object({
    observation: observationSchema,
    changes: z
      .array(z.object({ package: text, previous: text.nullable(), version: text }).strict())
      .max(100),
  })
  .strict();
type Observation = z.infer<typeof observationSchema>;
type Plan = z.infer<typeof planSchema>;
type Target = { key: string; revision: number; target: SecurityHostTarget };
type Inventory = {
  observation: Observation | null;
  observedAt?: string | null;
  error: string | null;
  connection: string;
};
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sq = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
const runKey = (serverId: string) => `security:host:${serverId}`;
const jobKey = (serverId: string) => `security:patch:${serverId}`;

export function hostTargets(advisories: readonly SecurityAdvisory[]): Target[] {
  return advisories.flatMap((a) =>
    a.targets.flatMap((target, index) =>
      target.kind === "host-package"
        ? [{ key: `${a.id}:${index}`, revision: a.revision, target }]
        : [],
    ),
  );
}
export const hostProbeKey = (advisories: readonly SecurityAdvisory[]) =>
  hash(hostTargets(advisories).sort((a, b) => a.key.localeCompare(b.key)));
function connectionKey(server: Server) {
  // Credentials are represented only by a hash; a connection change invalidates review.
  return hash([
    server.id,
    server.organizationId,
    server.workspaceId,
    server.purpose,
    server.isLocal,
    server.sshHost,
    server.sshPort,
    server.sshUser,
    server.sshTransport,
    server.updatedAt,
  ]);
}
async function host(ctx: ExecutionContext, id: string) {
  const server = await requireConnectedServer(ctx, id);
  if ((await isLocalHostRow(server)) && !(await resolveHostControlEnabled()))
    throw new AppError("Host control is disabled for this server.", 403, "HOST_EXECUTION_DISABLED");
  return server;
}
function command(
  mode: "inspect" | "plan" | "apply" | "plan-reboot" | "reboot",
  targets: Target[],
  expected?: Plan,
) {
  if (targets.length > 200) throw new ValidationError("Too many host rules for one inspection.");
  const arg = Buffer.from(JSON.stringify({ mode, targets, expected })).toString("base64");
  const python = `/usr/bin/python3 -I -c ${sq(HOST_SECURITY_SCRIPT)} ${sq(arg)}`;
  return mode === "inspect"
    ? python
    : `if [ "$(id -u)" = 0 ]; then ${python}; else /usr/bin/sudo -n -- ${python}; fi`;
}
function outputJson(output: string): unknown {
  if (output.length > 1_000_000)
    throw new ValidationError("Host inspection output exceeded its limit.");
  const line = output
    .split(/\r?\n/)
    .reverse()
    .find((line) => line.startsWith("OPENSHIP_HOST_SECURITY="));
  if (!line) throw new ValidationError("The host did not return a complete inspection.");
  return JSON.parse(line.slice("OPENSHIP_HOST_SECURITY=".length));
}
async function inspect(executor: CommandExecutor, targets: Target[]) {
  return observationSchema.parse(
    outputJson(await executor.exec(command("inspect", targets), { timeout: 15_000 })),
  );
}

export async function inspectHostSecurity(
  ctx: ExecutionContext,
  id: string,
  feed: AdvisoryFeedState,
  refresh = false,
) {
  await assertSecurityChecksEnabled(ctx.organizationId);
  const server = await repos.server.getInOrganization(id, ctx.organizationId);
  if (!server) throw new AppError("Server not found", 404);
  const key = hostProbeKey(feed.security?.advisories ?? []);
  const cached = await repos.securityAdvisory.host(id);
  const inventory = cached?.inventory as Inventory | null;
  if (
    !refresh &&
    cached?.probeKey === key &&
    inventory?.connection === connectionKey(server) &&
    !securityObservationDue(cached)
  )
    return;
  const targets = hostTargets(feed.security?.advisories ?? []);
  if (!targets.length) return; // A public feed with no host rules causes no host commands.
  const lock = await tryAcquireAdvisoryLock(runKey(id));
  if (!lock) return;
  try {
    // Recheck after cross-worker admission; failed inspections have a bounded retry cadence.
    const current = await repos.securityAdvisory.host(id);
    if (
      !refresh &&
      current?.probeKey === key &&
      (current.inventory as Inventory | null)?.connection === connectionKey(server) &&
      !securityObservationDue(current)
    )
      return;
    await assertSecurityChecksEnabled(ctx.organizationId);
    const checkedAt = new Date();
    let observation: Observation | null = null;
    let observedAt: string | null = checkedAt.toISOString();
    let error: string | null = null;
    try {
      await host(ctx, id);
      observation = await withServerExecution(ctx.organizationId, id, (executor) =>
        inspect(executor, targets),
      );
    } catch (cause) {
      reportCaughtError(cause, "security-advisories.host-inspection");
      error =
        "Host inspection unavailable. Check the connection, Ubuntu support and python3-apt, then retry.";
      const previous = current?.inventory as Inventory | null;
      if (current?.probeKey === key && previous?.connection === connectionKey(server)) {
        observation = previous.observation;
        observedAt = previous.observedAt ?? current.checkedAt?.toISOString() ?? null;
      } else observedAt = null;
    }
    const currentServer = await repos.server.getInOrganization(id, ctx.organizationId);
    if (!currentServer || connectionKey(currentServer) !== connectionKey(server)) return;
    const failures =
      error || observation?.rows.some((r) => r.state === "unknown")
        ? Math.min((current?.probeFailures ?? 0) + 1, 16)
        : 0;
    await repos.securityAdvisory.saveHost({
      serverId: id,
      organizationId: ctx.organizationId,
      inventory: { observation, observedAt, error, connection: connectionKey(server) },
      probeKey: key,
      checkedAt,
      probeFailures: failures,
      // Be eligible at the next scheduler tick while waiting for a kernel reboot.
      // Actual connection failures still use exponential backoff.
      nextInspectionAt:
        !error && observation?.rows.some((r) => r.state === "reboot_required")
          ? new Date(checkedAt.getTime() + 60_000)
          : nextSecurityInspection(id, checkedAt, failures),
    });
    if (observation && !error) await reconcileReboot(id, observation);
  } finally {
    await lock.release();
  }
}

export async function serverSecurityStatus(
  ctx: ExecutionContext,
  id: string,
  suppliedFeed?: AdvisoryFeedState,
): Promise<ServerSecurityResult> {
  const server = await repos.server.getInOrganization(id, ctx.organizationId);
  if (!server) throw new AppError("Server not found", 404);
  const [feed, checksEnabled, row] = await Promise.all([
    suppliedFeed ?? getAdvisoryFeed(ctx),
    repos.securityAdvisory.checksEnabled(ctx.organizationId),
    repos.securityAdvisory.host(id),
  ]);
  return buildServerSecurityStatus(ctx, server, feed, checksEnabled, row);
}

/** Bulk cache read for the root banner. No host connection or probe on page loads. */
export async function serverSecurityOverview(
  ctx: ExecutionContext,
  feed: AdvisoryFeedState,
): Promise<ServerSecurityResult[]> {
  if (!hostTargets(feed.security?.advisories ?? []).length) return [];
  const [servers, rows] = await Promise.all([
    repos.server.listByOrganization(ctx.organizationId),
    repos.securityAdvisory.hosts(ctx.organizationId),
  ]);
  const observations = new Map(rows.map((row) => [row.serverId, row]));
  const result: ServerSecurityResult[] = [];
  for (const server of servers) {
    if (server.workspaceId || server.purpose !== "deployment") continue;
    if (
      !(await authorization.checkPermissionOnResource(
        { ...ctx, scopeMode: "fixed" },
        { resourceType: "server", resourceId: server.id, action: "read" },
      ))
    )
      continue;
    result.push(
      await buildServerSecurityStatus(ctx, server, feed, true, observations.get(server.id)),
    );
  }
  return result;
}

async function buildServerSecurityStatus(
  ctx: ExecutionContext,
  server: Server,
  feed: AdvisoryFeedState,
  checksEnabled: boolean,
  row: Awaited<ReturnType<typeof repos.securityAdvisory.host>>,
): Promise<ServerSecurityResult> {
  const id = server.id;
  const canManage = await authorization.checkPermissionOnResource(
    { ...ctx, scopeMode: "fixed" },
    { resourceType: "server", resourceId: id, action: "admin" },
  );
  let supported = !server.workspaceId && server.purpose === "deployment" && !!server.sshHost;
  if (supported) {
    try {
      await assertServerExecution(server);
      if ((await isLocalHostRow(server)) && !(await resolveHostControlEnabled())) supported = false;
    } catch (error) {
      if (!(error instanceof AppError && [403, 404, 409].includes(error.statusCode)))
        reportCaughtError(error, "security-advisories.host-capability");
      supported = false;
    }
  }
  if (!supported) row = undefined;
  const inventory = row?.inventory as Inventory | null;
  const pending =
    supported &&
    hostTargets(feed.security?.advisories ?? []).length > 0 &&
    (!row ||
      row.probeKey !== hostProbeKey(feed.security?.advisories ?? []) ||
      inventory?.connection !== connectionKey(server) ||
      securityObservationDue(row));
  const result: ServerSecurityResult = {
    serverId: id,
    name: server.name ?? server.sshHost ?? id,
    checksEnabled,
    supported,
    canManage,
    checkedAt:
      inventory?.observedAt ??
      (inventory?.observation ? (row?.checkedAt?.toISOString() ?? null) : null),
    nextCheckAt: row?.nextInspectionAt?.toISOString() ?? null,
    error: inventory?.error ?? null,
    feedStale: feed.stale,
    findings: [],
    pending,
  };
  if (
    !inventory?.observation ||
    row?.probeKey !== hostProbeKey(feed.security?.advisories ?? []) ||
    inventory.connection !== connectionKey(server)
  )
    return result;
  for (const advisory of feed.security?.advisories ?? []) {
    const keys = new Set(hostTargets([advisory]).map((t) => t.key));
    const matches = inventory.observation.rows.filter(
      (r) => keys.has(r.key) && r.state !== "fixed",
    );
    if (!matches.length) continue;
    const canAct =
      supported &&
      checksEnabled &&
      canManage &&
      !inventory.error &&
      !feed.stale &&
      !pending &&
      advisory.action === "patch-host";
    result.findings.push({
      id: advisory.id,
      revision: advisory.revision,
      title: advisory.title,
      message: advisory.message,
      url: advisory.url,
      severity: advisory.severity,
      packages: matches.map((r) => r.package),
      evidence: matches.map(
        (r) =>
          `${r.package}: ${r.installed ?? "not installed"}${r.runningVersion ? `; running kernel source ${r.runningVersion}` : ""}`,
      ),
      state: matches.some((r) => r.state === "unknown")
        ? "unknown"
        : matches.every((r) => r.state === "reboot_required")
          ? "reboot_required"
          : "affected",
      canPatch: canAct && matches.every((r) => r.state === "affected" && r.installed !== null),
      canReboot: canAct && matches.every((r) => r.state === "reboot_required"),
    });
  }
  return result;
}

function sign(value: string) {
  return createHmac("sha256", env.BETTER_AUTH_SECRET)
    .update("openship-host-patch-v1:" + value)
    .digest();
}
const approvalSchema = z
  .object({
    version: z.literal(1),
    serverId: text,
    organizationId: text,
    userId: text,
    operation: z.enum(["install", "reboot"]),
    advisoryId: text,
    advisoryHash: text,
    connection: text,
    expiresAt: z.number(),
    plan: planSchema,
  })
  .strict();
export function decodeHostPatchToken(token: string) {
  const [payload, signature, extra] = token.split(".");
  const actual = Buffer.from(signature ?? "", "base64url");
  if (!payload || extra || actual.length !== 32 || !timingSafeEqual(actual, sign(payload)))
    throw new ValidationError("Invalid patch approval. Review a new plan.");
  const value = approvalSchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString()));
  if (value.expiresAt <= Date.now())
    throw new ValidationError("Patch plan expired. Review a new plan.");
  return value;
}
async function patchAdvisory(ctx: ExecutionContext, id: string, advisoryId: string) {
  await authorization.authorize(
    { ...ctx, scopeMode: "fixed" },
    { resourceType: "server", resourceId: id, action: "admin" },
  );
  await assertSecurityChecksEnabled(ctx.organizationId);
  const server = await host(ctx, id);
  const feed = await getAdvisoryFeed(ctx);
  const advisory = feed.security?.advisories.find((a) => a.id === advisoryId);
  if (
    feed.stale ||
    !advisory ||
    advisory.action !== "patch-host" ||
    !advisory.targets.every((t) => t.kind === "host-package")
  )
    throw new ValidationError("A current signed host-patch advisory is required.");
  return { server, advisory, feed };
}
export async function planHostPatch(
  ctx: ExecutionContext,
  id: string,
  input: { advisoryId: string; operation?: "install" | "reboot" },
): Promise<HostPatchPlan> {
  const operation = input.operation ?? "install";
  const { server, advisory, feed } = await patchAdvisory(ctx, id, input.advisoryId);
  const lock = await tryAcquireAdvisoryLock(runKey(id));
  if (!lock)
    throw new AppError("Server maintenance is already running. Try again after it finishes.", 409);
  try {
    const plan = await withServerExecution(
      ctx.organizationId,
      id,
      async (executor) =>
        planSchema.parse(
          outputJson(
            await executor.exec(
              command(operation === "reboot" ? "plan-reboot" : "plan", hostTargets([advisory])),
              { timeout: 120_000 },
            ),
          ),
        ),
      { mutation: true },
    );
    const expiresAt = Math.min(Date.now() + 10 * 60_000, Date.parse(feed.security!.expiresAt));
    const payload = Buffer.from(
      JSON.stringify({
        version: 1,
        operation,
        serverId: id,
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        advisoryId: advisory.id,
        advisoryHash: hash(advisory),
        connection: connectionKey(server),
        expiresAt,
        plan,
      }),
    ).toString("base64url");
    audit.recordAsync(operationAuditContext(ctx), {
      eventType: "server:admin",
      resourceType: "server",
      resourceId: id,
      after: {
        operation: "planSecurityPatch",
        advisoryId: advisory.id,
        packages: plan.changes.map((c) => c.package),
      },
    });
    return {
      operation,
      token: `${payload}.${sign(payload).toString("base64url")}`,
      expiresAt: new Date(expiresAt).toISOString(),
      advisoryId: advisory.id,
      title: advisory.title,
      changes: plan.changes,
      rebootRequired:
        advisory.targets.some((t) => t.kind === "host-package" && !!t.runningKernel) ||
        plan.observation.rebootRequired,
    };
  } finally {
    await lock.release();
  }
}
export async function applyHostPatch(ctx: ExecutionContext, id: string, input: { token: string }) {
  assertNativeJobs();
  const approval = decodeHostPatchToken(input.token);
  if (
    approval.serverId !== id ||
    approval.organizationId !== ctx.organizationId ||
    approval.userId !== ctx.userId
  )
    throw new AppError("Patch approval belongs to another server or account.", 403);
  const validate = async () => {
    const result = await patchAdvisory(ctx, id, approval.advisoryId);
    if (
      approval.expiresAt <= Date.now() ||
      hash(result.advisory) !== approval.advisoryHash ||
      connectionKey(result.server) !== approval.connection
    )
      throw new ValidationError("The advisory, connection or approval changed. Review a new plan.");
    return result;
  };
  await validate();
  const runId = `hpatch_${hash(input.token)}`;
  if (await repos.jobRun.findById(runId)) return { runId };
  const activeRuns = await repos.jobRun.listRecent({ jobId: jobKey(id), serverId: id, limit: 30 });
  if (activeRuns.some((r) => r.status === "running"))
    throw new AppError("A server patch or reboot still needs verification. Review Runs.", 409);
  const lock = await tryAcquireAdvisoryLock(runKey(id));
  if (!lock) throw new AppError("Server maintenance is already running.", 409);
  let accepted = false;
  try {
    if (
      (await repos.jobRun.listRecent({ jobId: jobKey(id), serverId: id, limit: 30 })).some(
        (r) => r.status === "running",
      )
    )
      throw new AppError("Server maintenance is already awaiting verification.", 409);
    const run = await repos.jobRun.startOnce(
      { jobId: jobKey(id), kind: "custom", trigger: "manual", serverId: id, serverIds: [id] },
      runId,
    );
    if (!run) return { runId };
    const summary = {
      advisoryId: approval.advisoryId,
      operation: approval.operation,
      bootId: approval.plan.observation.bootId,
      changes: approval.plan.changes,
      phase: "queued",
    };
    await repos.jobRun.progress(runId, summary);
    audit.recordAsync(operationAuditContext(ctx), {
      eventType: "server:admin",
      resourceType: "server",
      resourceId: id,
      after: { operation: "applySecurityPatch", advisoryId: approval.advisoryId, runId },
    });
    const work = deferBackgroundWork(async () => {
      const started = Date.now();
      let output = "";
      let checkpoint = Promise.resolve();
      let lastCheckpoint = 0;
      try {
        const { advisory } = await validate();
        await repos.jobRun.progress(runId, { ...summary, phase: "installing" });
        const result = await withServerExecution(
          ctx.organizationId,
          id,
          (executor) =>
            executor.streamExec(
              command(
                approval.operation === "reboot" ? "reboot" : "apply",
                hostTargets([advisory]),
                approval.plan,
              ),
              (entry) => {
                output = (output + entry.message + "\n").slice(-200_000);
                jobRunBus.publish(runId, { type: "log", line: entry.message, level: entry.level });
                if (Date.now() - lastCheckpoint > 2000) {
                  lastCheckpoint = Date.now();
                  const snapshot = output;
                  checkpoint = checkpoint
                    .then(() =>
                      repos.jobRun.progress(runId, { ...summary, phase: "installing" }, snapshot),
                    )
                    .catch((error) => {
                      reportCaughtError(error, "security-advisories.host-run-checkpoint");
                    });
                }
              },
              { signal: AbortSignal.timeout(10 * 60_000) },
            ),
          { mutation: true },
        );
        output = result.output.slice(-200_000);
        if (result.code !== 0)
          throw new ValidationError(
            "The host patch did not complete. Review the run output before retrying.",
          );
        const observed = observationSchema.parse(outputJson(result.output));
        if (
          observed.rows.some((r) => r.state === "affected" || r.state === "unknown") ||
          !observed.rows.length
        )
          throw new ValidationError(
            "The installed patch could not be verified. Review the server.",
          );
        const phase =
          observed.rows.some((r) => r.state === "reboot_required") || observed.rebootRequired
            ? "reboot_required"
            : "verified";
        await checkpoint;
        if (approval.operation === "reboot") {
          await repos.jobRun.progress(
            runId,
            { ...summary, phase: "rebooting", kernel: observed.kernel },
            output,
          );
        } else {
          await repos.jobRun.finish(runId, {
            status: "success",
            output,
            durationMs: Date.now() - started,
            summary: { ...summary, phase, kernel: observed.kernel },
          });
        }
      } catch (error) {
        reportCaughtError(error, "security-advisories.host-patch");
        await checkpoint;
        await repos.jobRun.finish(runId, {
          status: "failed",
          output,
          durationMs: Date.now() - started,
          error: safeErrorMessage(error),
          summary: { ...summary, phase: "needs_review" },
        });
      } finally {
        try {
          const finished = await repos.jobRun.findById(runId);
          if (finished && finished.status !== "running")
            jobRunBus.publish(runId, {
              type: "complete",
              status: finished.status === "success" ? "success" : "failed",
              error: finished.error,
            });
        } finally {
          await lock.release();
        }
      }
      // Renew findings after execution. A successful install alone never clears a kernel warning.
      const feed = await getAdvisoryFeed(ctx);
      if (await repos.securityAdvisory.checksEnabled(ctx.organizationId))
        await inspectHostSecurity(ctx, id, feed, true);
    });
    accepted = true;
    void work.catch(() => {
      // diagnostics-ignore: deferBackgroundWork already reports rejections and owns shutdown drainage.
    });
    return { runId };
  } finally {
    if (!accepted) await lock.release();
  }
}

async function reconcileReboot(id: string, observation: Observation) {
  const runs = await repos.jobRun.listRecent({ jobId: jobKey(id), serverId: id, limit: 30 });
  for (const run of runs) {
    const summary = run.summary as Record<string, unknown> | null;
    if (
      run.status !== "running" ||
      summary?.phase !== "rebooting" ||
      summary.bootId === observation.bootId
    )
      continue;
    const rows = observation.rows.filter((r) => r.key.startsWith(`${summary.advisoryId}:`));
    const verified = rows.length > 0 && rows.every((r) => r.state === "fixed");
    await repos.jobRun.finish(run.id, {
      status: verified ? "success" : "failed",
      durationMs: Date.now() - run.startedAt.getTime(),
      summary: {
        ...summary,
        phase: verified ? "verified" : "needs_review",
        kernel: observation.kernel,
      },
      ...(verified
        ? {}
        : { error: "The host restarted but the running kernel fix could not be verified." }),
    });
    jobRunBus.publish(run.id, { type: "complete", status: verified ? "success" : "failed" });
  }
}

export async function hostPatchRuns(ctx: ExecutionContext, id: string) {
  await host(ctx, id);
  const runs = await repos.jobRun.listRecent({ jobId: jobKey(id), serverId: id, limit: 30 });
  for (const run of runs) {
    // Never retry an interrupted privileged operation. The host must be inspected first.
    const waitingForBoot = (run.summary as Record<string, unknown> | null)?.phase === "rebooting";
    if (
      run.status === "running" &&
      Date.now() - run.startedAt.getTime() > (waitingForBoot ? 30 : 15) * 60_000
    ) {
      const lock = await tryAcquireAdvisoryLock(runKey(id));
      if (lock) {
        try {
          await repos.jobRun.finish(run.id, {
            status: "failed",
            error: "Execution was interrupted. Check the host before preparing another patch.",
            summary: { ...(run.summary as object), phase: "needs_review" },
          });
          run.status = "failed";
          run.summary = { ...(run.summary as object), phase: "needs_review" };
          run.error = "Execution was interrupted. Check the host before preparing another patch.";
        } finally {
          await lock.release();
        }
      }
    }
  }
  return runs.map((run) => ({
    ...run,
    summary: run.summary as Record<string, unknown> | null,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    createdAt: run.createdAt.toISOString(),
  }));
}
export const serverSecurityResources = {
  security: serverSecurityStatus,
  async checkSecurity(ctx: ExecutionContext, id: string) {
    const feed = await getAdvisoryFeed(ctx);
    await inspectHostSecurity(ctx, id, feed, true);
    return serverSecurityStatus(ctx, id, feed);
  },
  planSecurityPatch: planHostPatch,
  applySecurityPatch: applyHostPatch,
  securityRuns: hostPatchRuns,
};
