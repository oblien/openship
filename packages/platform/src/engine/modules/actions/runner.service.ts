import {
  AppError,
  NotFoundError,
  ValidationError,
  generateId,
  incompatibleActionLabels,
  safeErrorMessage,
} from "@repo/core";
import { probeActionCapabilities } from "@repo/adapters";
import { repos } from "@repo/db";
import type { Static } from "@sinclair/typebox";
import type { ActionCollectionSchemas } from "@repo/contracts";
import type { ExecutionContext } from "../../../context";
import { withServerExecution } from "../../lib/server-execution";
import { assertJobServersWritable } from "../jobs/job-access";
import { authorizeActionRunners } from "./access";

type RunnerInput = Static<typeof ActionCollectionSchemas.addRunner.input>;

export async function inspectActionDestination(ctx: ExecutionContext, serverId: string) {
  await assertJobServersWritable(ctx, [serverId]);
  return withServerExecution(ctx.organizationId, serverId, probeActionCapabilities);
}

export async function saveActionRunner(ctx: ExecutionContext, input: RunnerInput, id?: string) {
  if (id) await authorizeActionRunners(ctx, [id], true);
  await assertJobServersWritable(ctx, [input.serverId]);
  const existing = id ? await repos.actions.runner(ctx.organizationId, id) : undefined;
  if (existing?.cloudPoolId)
    throw new ValidationError("Cloud runner pools are configured by the instance operator");
  if (existing && (await repos.actions.runnerBusy(ctx.organizationId, existing.id)))
    throw new AppError(
      "Wait for this runner's jobs to finish before changing its configuration",
      409,
      "ACTIONS_RUNNER_BUSY",
    );
  const duplicate = (await repos.actions.listRunners(ctx.organizationId)).find(
    (r) => r.serverId === input.serverId && r.id !== id,
  );
  if (duplicate)
    throw new AppError(
      "This server already has an Actions runner. Edit that runner instead.",
      409,
      "ACTIONS_RUNNER_EXISTS",
    );
  const capabilities = await withServerExecution(
    ctx.organizationId,
    input.serverId,
    probeActionCapabilities,
  );
  const invalid = incompatibleActionLabels(capabilities, input.config);
  if (invalid.length)
    throw new ValidationError(
      `These labels do not match this runner's capabilities: ${invalid.join(", ")}`,
    );
  if (input.config.mode === "container" && (!capabilities.docker || !input.config.image))
    throw new ValidationError("Container runners need a working Docker engine and a runner image");
  if (input.config.mode === "native" && !capabilities.git)
    throw new ValidationError("Install Git before adding a native Actions runner");
  if (input.config.mode === "native" && !capabilities.node)
    throw new ValidationError("Install Node.js before adding a native Actions runner");
  return repos.actions.saveRunner({
    id: existing?.id ?? generateId("arunner"),
    organizationId: ctx.organizationId,
    serverId: input.serverId,
    cloudPoolId: null,
    name: input.name.trim(),
    config: input.config,
    capabilities,
    enabled: input.enabled ?? true,
    checkedAt: new Date(),
    error: null,
  });
}

export async function probeActionRunner(ctx: ExecutionContext, id: string) {
  await authorizeActionRunners(ctx, [id], true);
  const row = await repos.actions.runner(ctx.organizationId, id);
  if (!row) throw new NotFoundError("Actions runner", id);
  if (!row.serverId) return row;
  try {
    const capabilities = await withServerExecution(
      ctx.organizationId,
      row.serverId,
      probeActionCapabilities,
    );
    const saved = await repos.actions.recordRunnerProbe(ctx.organizationId, id, {
      capabilities,
      error: null,
      checkedAt: new Date(),
    });
    if (!saved) throw new NotFoundError("Actions runner", id);
    return saved;
  } catch (error) {
    await repos.actions.recordRunnerProbe(ctx.organizationId, id, {
      capabilities: null,
      error: safeErrorMessage(error),
      checkedAt: new Date(),
    });
    throw error;
  }
}
