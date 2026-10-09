import { createHash } from "node:crypto";
import { parse } from "yaml";
import { AppError, NotFoundError, ValidationError, generateId, isFullCommitSha } from "@repo/core";
import { repos, type ActionRun, type ActionWorkflow } from "@repo/db";
import type { CreateActionWorkflow } from "@repo/contracts";
import type { ExecutionContext } from "../../../context";
import { captureExecutionAuthority } from "../../lib/execution-authority";
import { encrypt } from "../../lib/encryption";
import { githubFetch } from "../github/github.auth";
import { getFileContent, listFiles } from "../github/github.service";
import {
  authorizeActionRunners,
  authorizeActionWorkflow,
  authorizeActionRun,
  authorizeActionRepository,
} from "./access";
import { actionConcurrency, parseActionWorkflow, record } from "./workflow";
import { actionRuntimeUrl, authorizeActionStorage } from "./storage";

export async function requireActionWorkflow(
  ctx: ExecutionContext,
  id: string,
  write = false,
): Promise<ActionWorkflow> {
  const row = await repos.actions.workflow(ctx.organizationId, id);
  if (!row) throw new NotFoundError("Workflow", id);
  await authorizeActionWorkflow(ctx, row, write);
  return row;
}
export async function requireActionRun(
  ctx: ExecutionContext,
  id: string,
  write = false,
): Promise<ActionRun> {
  const row = await repos.actions.run(ctx.organizationId, id);
  if (!row) throw new NotFoundError("Workflow run", id);
  await authorizeActionRun(ctx, row, write);
  return row;
}

export async function saveActionWorkflow(
  ctx: ExecutionContext,
  input: CreateActionWorkflow,
  id?: string,
): Promise<ActionWorkflow> {
  const existing = id ? await requireActionWorkflow(ctx, id, true) : undefined;
  await authorizeActionRunners(ctx, input.runnerIds, true);
  if (input.allowForks ?? existing?.allowForks) {
    const runners = await Promise.all(
      input.runnerIds.map((runnerId) => repos.actions.runner(ctx.organizationId, runnerId)),
    );
    if (!runners.some((runner) => runner?.cloudPoolId && runner.enabled))
      throw new ValidationError("Fork pull requests need an enabled disposable Cloud runner pool");
  }
  await authorizeActionRepository(ctx, input.owner, input.repo);
  const source =
    input.source ??
    (await getFileContent(ctx, input.owner, input.repo, input.path, { branch: input.ref })).content;
  const definition = await parseActionWorkflow(source, input.path);
  const storageDestinationId =
    input.storageDestinationId === undefined
      ? (existing?.storageDestinationId ?? null)
      : input.storageDestinationId;
  if (storageDestinationId) {
    actionRuntimeUrl();
    await authorizeActionStorage(ctx, storageDestinationId, true);
  }
  if (
    !storageDestinationId &&
    /uses:\s*['"]?actions\/(?:upload-artifact|download-artifact|cache)(?:\/|@)/i.test(source)
  )
    throw new ValidationError("Choose artifact and cache storage before enabling this workflow");
  const secrets = { ...existing?.secrets };
  for (const key of input.removeSecrets ?? []) delete secrets[key];
  for (const [key, value] of Object.entries(input.secrets ?? {})) {
    if (/^(GITHUB_|ACTIONS_|RUNNER_|OPENSHIP_)/i.test(key))
      throw new ValidationError(
        `${key} is reserved. Store a token under a custom secret name and reference it explicitly in your workflow.`,
      );
    if (value) secrets[key] = encrypt(value);
  }
  return repos.actions.saveWorkflow({
    id: existing?.id ?? generateId("awf"),
    organizationId: ctx.organizationId,
    name: input.name.trim(),
    owner: input.owner.toLowerCase(),
    repo: input.repo.toLowerCase(),
    path: input.path,
    ref: input.ref,
    source: input.source ?? null,
    definition,
    lastError: null,
    runnerIds: input.runnerIds,
    variables: input.variables ?? existing?.variables ?? {},
    secrets,
    authority: await captureExecutionAuthority(ctx),
    enabled: input.enabled ?? existing?.enabled ?? true,
    allowForks: input.allowForks ?? existing?.allowForks ?? false,
    storageDestinationId,
  });
}

export async function discoverActionWorkflows(
  ctx: ExecutionContext,
  owner: string,
  repo: string,
  ref: string,
) {
  await authorizeActionRepository(ctx, owner, repo);
  const results: Array<{ path: string; name: string }> = [];
  for (const path of [".github/workflows", ".openship/workflows"]) {
    try {
      for (const file of await listFiles(ctx, owner, repo, { branch: ref, path }))
        if (file.type === "file" && /\.ya?ml$/i.test(file.name))
          results.push({ path: file.path, name: file.name });
    } catch (error) {
      // A missing folder is normal. Auth, network and rate-limit errors remain visible.
      if (!(error instanceof Error && "status" in error && error.status === 404)) throw error;
    }
  }
  return results;
}

function dispatchInputs(
  source: string,
  provided: Record<string, unknown>,
): Record<string, unknown> {
  const definitions = record(
    record(record(parse(source, { maxAliasCount: 0 })).on).workflow_dispatch,
  ).inputs;
  const inputs = record(definitions);
  for (const key of Object.keys(provided))
    if (!(key in inputs)) throw new ValidationError(`Unknown workflow input: ${key}`);
  const result: Record<string, unknown> = {};
  for (const [key, definition] of Object.entries(inputs)) {
    const spec = record(definition);
    const value = provided[key] ?? spec.default;
    if (spec.required && (value === undefined || value === ""))
      throw new ValidationError(`Workflow input ${key} is required`);
    if (value === undefined) {
      result[key] = spec.type === "boolean" ? false : spec.type === "number" ? 0 : "";
      continue;
    }
    if (spec.type === "boolean") {
      if (![true, false, "true", "false"].includes(value as string | boolean))
        throw new ValidationError(`${key} must be true or false`);
      result[key] = value === true || value === "true";
    } else if (spec.type === "number") {
      const number = Number(value);
      if (!Number.isFinite(number)) throw new ValidationError(`${key} must be a number`);
      result[key] = number;
    } else {
      if (spec.type === "environment")
        throw new ValidationError("Protected environment inputs are not supported yet");
      if (spec.type === "choice" && (!Array.isArray(spec.options) || !spec.options.includes(value)))
        throw new ValidationError(`${key} is not an allowed choice`);
      result[key] = String(value);
    }
  }
  return result;
}

export interface ActionTrigger {
  key: string;
  ref?: string;
  revision?: string;
  eventName: "workflow_dispatch" | "push" | "pull_request" | "schedule";
  event?: Record<string, unknown>;
  inputs?: Record<string, unknown>;
  actor?: string;
  untrusted?: boolean;
  /** A PR uses the trusted base workflow, while checkout receives its immutable merge ref. */
  workflowRevision?: string;
}

async function resolveActionRef(
  ctx: ExecutionContext,
  workflow: ActionWorkflow,
  base: string,
  selected: string,
): Promise<string> {
  if (selected.startsWith("refs/")) return selected;
  for (const kind of ["heads", "tags"]) {
    // Matching refs returns an empty list for a missing branch. An exact match
    // avoids accepting a similarly named branch and preserves bare tag refs.
    const refs = await githubFetch<Array<{ ref: string }>>({
      ctx,
      owner: workflow.owner,
      repo: workflow.repo,
      url: `${base}/git/matching-refs/${kind}/${encodeURIComponent(selected)}`,
    });
    const ref = `refs/${kind}/${selected}`;
    if (refs.some((value) => value.ref === ref)) return ref;
  }
  throw new ValidationError(`Branch or tag ${selected} was not found`);
}

export async function triggerActionWorkflow(
  ctx: ExecutionContext,
  workflow: ActionWorkflow,
  trigger: ActionTrigger,
): Promise<ActionRun> {
  await authorizeActionWorkflow(ctx, workflow, true);
  const idempotencyKey = `${workflow.id}:${trigger.eventName}:${trigger.key}`;
  const existing = await repos.actions.runByKey(ctx.organizationId, idempotencyKey);
  if (existing) return existing;
  if (!workflow.enabled)
    throw new AppError("This workflow is disabled", 409, "ACTIONS_WORKFLOW_DISABLED");
  if (trigger.untrusted && !workflow.allowForks)
    throw new AppError(
      "Fork pull requests are disabled for this workflow",
      409,
      "ACTIONS_FORK_DISABLED",
    );
  let selectedRef = trigger.ref ?? workflow.ref;
  const base = `https://api.github.com/repos/${encodeURIComponent(workflow.owner)}/${encodeURIComponent(workflow.repo)}`;
  const repo = await githubFetch<{
    default_branch: string;
    private: boolean;
    full_name: string;
    id: number;
  }>({ ctx, owner: workflow.owner, repo: workflow.repo, url: base });
  if (trigger.eventName === "schedule") selectedRef = repo.default_branch;
  const ref = await resolveActionRef(ctx, workflow, base, selectedRef);
  const revision =
    trigger.revision ??
    (
      await githubFetch<{ sha: string }>({
        ctx,
        owner: workflow.owner,
        repo: workflow.repo,
        url: `${base}/commits/${encodeURIComponent(ref)}`,
      })
    ).sha;
  if (!isFullCommitSha(revision))
    throw new ValidationError("GitHub did not resolve an immutable workflow commit");
  const source =
    workflow.source ??
    (
      await getFileContent(ctx, workflow.owner, workflow.repo, workflow.path, {
        branch: trigger.workflowRevision ?? revision,
      })
    ).content;
  const plan = await parseActionWorkflow(source, workflow.path);
  if (!workflow.source && ref === `refs/heads/${repo.default_branch}`)
    await repos.actions.refreshDefinition(
      workflow.organizationId,
      workflow.id,
      plan,
      workflow.updatedAt,
    );
  if (!(trigger.eventName in plan.triggers))
    throw new ValidationError(`This workflow does not declare on: ${trigger.eventName}`);
  if (
    trigger.eventName === "schedule" &&
    !(
      Array.isArray(plan.triggers.schedule) &&
      plan.triggers.schedule.some((entry) => record(entry).cron === trigger.event?.schedule)
    )
  )
    throw new ValidationError(
      "This schedule has changed in the repository; the next run will use its updated schedule",
    );
  const inputs =
    trigger.eventName === "workflow_dispatch" ? dispatchInputs(source, trigger.inputs ?? {}) : {};
  const event = {
    ...trigger.event,
    repository: { ...repo, ...record(trigger.event?.repository) },
    inputs,
  };
  const concurrency = actionConcurrency(plan.concurrency, {
    github: {
      event,
      event_name: trigger.eventName,
      repository: `${workflow.owner}/${workflow.repo}`,
      ref,
      sha: revision,
      workflow: plan.name,
    },
    vars: workflow.variables,
    inputs,
  });
  const group = concurrency
    ? createHash("sha256")
        .update(`${workflow.owner}/${workflow.repo}:${concurrency.group}`)
        .digest("hex")
    : null;
  return repos.actions.createRun({
    id: generateId("arun"),
    organizationId: ctx.organizationId,
    workflowId: workflow.id,
    idempotencyKey,
    source,
    plan,
    revision,
    ref,
    eventName: trigger.eventName,
    event,
    inputs,
    actor: trigger.actor ?? ctx.user.name ?? ctx.userId,
    authority: await captureExecutionAuthority(ctx),
    untrusted: !!trigger.untrusted,
    status: trigger.untrusted ? "waiting" : "queued",
    concurrencyGroup: group,
    cancelInProgress: concurrency?.cancelInProgress ?? false,
    configuration: {
      owner: workflow.owner,
      repo: workflow.repo,
      path: workflow.path,
      defaultBranch: repo.default_branch,
      runnerIds: workflow.runnerIds,
      variables: trigger.untrusted ? {} : workflow.variables,
      secrets: trigger.untrusted ? {} : workflow.secrets,
      storageDestinationId: workflow.storageDestinationId,
    },
  });
}

export async function rerunActionWorkflow(
  ctx: ExecutionContext,
  id: string,
  key: string,
): Promise<ActionRun> {
  const run = await requireActionRun(ctx, id, true);
  if (!run.finishedAt)
    throw new AppError("Cancel or finish this run before retrying it", 409, "ACTIONS_RUN_ACTIVE");
  const { id: _id, createdAt, updatedAt, ...snapshot } = run;
  return repos.actions.createRun({
    ...snapshot,
    id: generateId("arun"),
    originalRunId: run.originalRunId ?? run.id,
    attempt: run.attempt + 1,
    idempotencyKey: `${run.workflowId}:rerun:${key}`,
    authority: await captureExecutionAuthority(ctx),
    status: run.untrusted ? "waiting" : "queued",
    expandedJobs: [],
    cancelRequestedAt: null,
    leaseOwner: null,
    leaseUntil: null,
    error: null,
    startedAt: null,
    finishedAt: null,
    settledAt: null,
    approvedAt: null,
    approvedBy: null,
  });
}
