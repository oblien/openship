/** Job keys are instance-global; authority comes from the stored target servers. */
import { AppError, NotFoundError } from "@repo/contracts";
import { repos } from "@repo/db";
import type { ExecutionContext } from "../../../context";
import { authorization } from "../../lib/authorization";
import { instanceAuthorization } from "../../lib/instance-authorization";
import { isServerInOrg } from "../../lib/resource-access";
import { assertSelfHosted } from "../system/server-access";
import { systemJobAvailability } from "./job.service";
import { resolveServerIds, type CommandConfig } from "./job.types";

const missingJob = () => new NotFoundError("Job");
const denied = (error: unknown) => error instanceof AppError && [401, 403, 404].includes(error.statusCode);

export async function assertJobServersWritable(ctx: ExecutionContext, serverIds: string[]): Promise<void> {
  for (const serverId of new Set(serverIds)) {
    await authorization.authorize({ ...ctx, scopeMode: "fixed" }, { resourceType: "server", resourceId: serverId, action: "admin" });
    if (!(await isServerInOrg(ctx, serverId))) throw new NotFoundError("Server", serverId);
  }
}

async function canAccessServers(ctx: ExecutionContext, ids: string[], action: "read" | "write"): Promise<boolean> {
  // No target means no provable tenant ownership, including legacy/corrupt rows.
  if (!ids.length) return instanceAuthorization.allows(ctx, action);
  try { await assertJobServersWritable(ctx, ids); return true; }
  catch (error) { if (denied(error)) return false; throw error; }
}

export async function assertJobWritable(
  ctx: ExecutionContext,
  key: string,
  patch?: { serverId?: string; serverIds?: string[] },
  options: { allowMissingRegisteredSystem?: boolean } = {},
): Promise<void> {
  assertSelfHosted();
  const row = await repos.job.findByKey(key);
  if (!row) {
    if (!options.allowMissingRegisteredSystem || systemJobAvailability(key) !== "available") throw missingJob();
    await instanceAuthorization.assert(ctx);
    return;
  }
  if (systemJobAvailability(key) === "unavailable") throw missingJob();
  if (row.actionType === "builtin") { await instanceAuthorization.assert(ctx); return; }
  const stored = resolveServerIds((row.actionConfig ?? {}) as CommandConfig);
  if (!(await canAccessServers(ctx, stored, "write"))) throw missingJob();
  // An update merges config. Both the stored targets and any added targets matter.
  if (patch && !(await canAccessServers(ctx, [...stored, ...resolveServerIds(patch)], "write"))) throw missingJob();
}

/** Shared with credential disclosure and incoming-webhook dispatch. Never rebinds ctx. */
export async function assertJobRunnable(ctx: ExecutionContext, key: string): Promise<void> {
  await authorization.authorize({ ...ctx, scopeMode: "fixed" }, { resourceType: "job", resourceId: "*", action: "write" });
  await assertJobWritable(ctx, key);
}

export async function canRunJob(ctx: ExecutionContext, key: string): Promise<boolean> {
  try { await assertJobRunnable(ctx, key); return true; }
  catch (error) { if (denied(error)) return false; throw error; }
}

export async function canReadJob(ctx: ExecutionContext, row: { key: string; actionType: string; actionConfig: unknown }): Promise<boolean> {
  if (systemJobAvailability(row.key) === "unavailable") return false;
  return row.actionType !== "command" || canAccessServers(ctx, resolveServerIds((row.actionConfig ?? {}) as CommandConfig), "read");
}

export async function requireReadableJob(ctx: ExecutionContext, key: string) {
  assertSelfHosted();
  const row = await repos.job.findByKey(key);
  if (!row || !(await canReadJob(ctx, row))) throw missingJob();
  return row;
}

export async function requireReadableRun(ctx: ExecutionContext, id: string) {
  assertSelfHosted();
  const run = await repos.jobRun.findById(id);
  if (!run || !(await canReadRun(ctx, run))) throw new NotFoundError("Run");
  return run;
}

export async function canReadRun(ctx: ExecutionContext, run: { kind: string; jobId: string; serverId: string | null; serverIds?: string[] | null }): Promise<boolean> {
  if (run.kind === "custom") {
    // Only persisted execution targets prove who may read historical output.
    // Legacy aggregate rows have no target snapshot: instance-admin access only.
    const targets = run.serverIds ?? (run.serverId ? [run.serverId] : []);
    return canAccessServers(ctx, targets, "read");
  }
  return true;
}

export async function assertJobReferences(ctx: ExecutionContext, input: { dependsOn?: string[]; notifyConfig?: { channels: string[] } | null }) {
  for (const key of new Set(input.dependsOn ?? [])) await requireReadableJob(ctx, key);
  for (const id of new Set(input.notifyConfig?.channels ?? [])) {
    const channel = await repos.notificationChannel.findById(id);
    if (!channel || channel.userId !== ctx.userId) throw new NotFoundError("Notification channel", id);
  }
}
