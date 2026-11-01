import { createHash } from "node:crypto";
import {
  ValidationError,
  type ActionCallFrame,
  type ActionJobDefinition,
  type ActionJobSpec,
  type ActionWorkflowSnapshot,
} from "@repo/core";
import type { ActionRun } from "@repo/db";
import { actionContext } from "./context";
import { evaluateTemplate, type ActionExpressionContext } from "./expressions";
import { actionConcurrency, actionPermissions, parseActionWorkflow, record } from "./workflow";

type Source = Omit<ActionWorkflowSnapshot, "plan" | "calls">;
export type ReusableSourceReader = (reference: string, caller: Source) => Promise<Source>;

/** Resolve once, before admission. Neither retries nor a moved tag change the
 * code covered by the user's approval. The worker still receives one leaf job. */
export async function snapshotActionWorkflows(root: Source, read: ReusableSourceReader) {
  const result: Record<string, ActionWorkflowSnapshot> = {};
  let bytes = 0;
  const visiting = new Set<string>();
  const reads = new Map<string, Promise<Source>>();
  const identity = (source: Source) =>
    `${source.owner?.toLowerCase()}/${source.repo?.toLowerCase()}/${source.path}@${source.sha}`;
  const visit = async (source: Source, key: string, depth: number): Promise<string> => {
    const id = identity(source);
    if (visiting.has(id)) throw new ValidationError(`Reusable workflow cycle: ${source.path}`);
    if (depth > 10) throw new ValidationError("Reusable workflows exceed 10 nesting levels");
    if (result[key]) return key;
    if (Object.keys(result).length >= 51)
      throw new ValidationError("A workflow can import at most 50 reusable workflows");
    bytes += Buffer.byteLength(source.source);
    if (bytes > 2 * 1024 * 1024)
      throw new ValidationError("Combined reusable workflow source exceeds 2 MiB");
    const plan = await parseActionWorkflow(source.source, source.path);
    if (depth > 1 && !("workflow_call" in plan.triggers))
      throw new ValidationError(`${source.path} must declare on: workflow_call`);
    result[key] = { ...source, plan, calls: {} };
    visiting.add(id);
    for (const job of plan.jobs) {
      if (!job.uses) continue;
      const referenceKey = job.uses.startsWith("./")
        ? `${source.owner}/${source.repo}@${source.sha}:${job.uses}`
        : job.uses;
      let pending = reads.get(referenceKey);
      if (!pending) {
        pending = read(job.uses, source);
        reads.set(referenceKey, pending);
      }
      const called = await pending;
      const child = await visit(
        called,
        createHash("sha256").update(identity(called)).digest("hex"),
        depth + 1,
      );
      const declaration = record(result[child]!.plan.triggers.workflow_call);
      const inputs = record(declaration.inputs);
      for (const name of Object.keys(job.with ?? {}))
        if (!(name in inputs))
          throw new ValidationError(`${job.id}: unknown workflow input ${name}`);
      for (const [name, value] of Object.entries(inputs))
        if (record(value).required === true && !(name in (job.with ?? {})))
          throw new ValidationError(`${job.id}: required workflow input ${name} is missing`);
      if (job.secrets === "inherit") {
        if (!source.owner || source.owner.toLowerCase() !== called.owner?.toLowerCase())
          throw new ValidationError(
            `${job.id}: secrets: inherit requires workflows owned by the same account or organization; map secrets explicitly for other owners`,
          );
      } else {
        for (const name of Object.keys(job.secrets ?? {}))
          if (!(name in record(declaration.secrets)))
            throw new ValidationError(`${job.id}: unknown workflow secret ${name}`);
      }
      result[key]!.calls[job.id] = child;
    }
    visiting.delete(id);
    return key;
  };
  await visit(root, "root", 1);
  return result;
}

export function scopedActionRun(run: ActionRun, scope: ActionCallFrame[] = []): ActionRun {
  const frame = scope.at(-1);
  if (!frame) return run;
  const source = run.configuration.workflows?.[frame.sourceId];
  if (!source)
    throw new ValidationError("The saved reusable workflow is unavailable; rerun from its source");
  return {
    ...run,
    source: source.source,
    plan: source.plan,
    inputs: frame.inputs,
    configuration: { ...run.configuration, path: source.path },
  };
}

/** A called workflow can retain or narrow the caller's grant, never expand it. */
export function calledPermissions(requested: unknown, ceiling: ActionJobSpec["permissions"]) {
  if (requested === undefined) return { ...ceiling };
  const result = actionPermissions(requested);
  for (const [name, access] of Object.entries(result))
    if (!ceiling[name] || (access === "write" && ceiling[name] !== "write"))
      throw new ValidationError(`Called workflow cannot increase permission ${name} to ${access}`);
  return result;
}

export function calledInputs(
  declaration: unknown,
  provided: unknown,
  context: ActionExpressionContext,
) {
  const values = record(evaluateTemplate(provided ?? {}, context));
  const definitions = record(record(declaration).inputs);
  const result: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(definitions)) {
    const input = record(value);
    if (!(name in values) && input.required === true)
      throw new ValidationError(`Required workflow input ${name} is missing`);
    const chosen =
      values[name] ??
      evaluateTemplate(
        input.default ?? (input.type === "boolean" ? false : input.type === "number" ? 0 : ""),
        context,
      );
    if (typeof chosen !== input.type || (typeof chosen === "number" && !Number.isFinite(chosen)))
      throw new ValidationError(`Workflow input ${name} must be a ${String(input.type)}`);
    result[name] = chosen;
  }
  return result;
}

export function scopeActionJob(
  run: ActionRun,
  definition: ActionJobDefinition,
  spec: ActionJobSpec,
  scope: ActionCallFrame[],
) {
  const frame = scope.at(-1);
  if (frame) {
    spec.scope = scope;
    spec.name = `${frame.name} / ${spec.name}`;
    spec.permissions = calledPermissions(
      definition.permissions ?? run.plan.permissions,
      frame.permissions,
    );
  }
  if (definition.uses) {
    const sourceId = run.configuration.workflows?.[frame?.sourceId ?? "root"]?.calls[definition.id];
    const source = sourceId && run.configuration.workflows?.[sourceId];
    if (!source || !sourceId)
      throw new ValidationError(
        "Reusable workflow source was not resolved before this attempt; start a new run",
      );
    const context = {
      ...actionContext(run, spec.needs),
      matrix: spec.matrix,
      strategy: spec.strategy,
    };
    const inputs = calledInputs(source.plan.triggers.workflow_call, definition.with, context);
    // Check the workflow-wide ceiling before allocating any callee runner.
    calledPermissions(source.plan.permissions, spec.permissions);
    spec.call = { sourceId, inputs };
    spec.workflowConcurrency = actionConcurrency(source.plan.concurrency, { ...context, inputs });
  }
  return spec;
}

export function actionCallFrame(
  run: ActionRun,
  jobId: string,
  spec: ActionJobSpec,
): ActionCallFrame {
  const scoped = scopedActionRun(run, spec.scope);
  const definition = scoped.plan.jobs.find((job) => job.id === spec.jobId)!;
  return {
    jobId,
    sourceId: spec.call!.sourceId,
    name: spec.name,
    inputs: spec.call!.inputs,
    permissions: spec.permissions,
    caller: {
      inputs: scoped.inputs,
      matrix: spec.matrix,
      needs: spec.needs,
      strategy: spec.strategy,
    },
    secrets: definition.secrets ?? {},
  };
}

/** Executed only in memory, after decryption. Secret values never enter scopes,
 * run views or diagnostics. Each call must explicitly forward its own grant. */
export function calledSecrets(
  run: ActionRun,
  scope: ActionCallFrame[] | undefined,
  values: Record<string, string>,
  githubToken?: string,
) {
  let secrets = { ...values };
  for (const frame of scope ?? []) {
    const source = run.configuration.workflows![frame.sourceId]!;
    const available = { ...secrets, ...(githubToken && { GITHUB_TOKEN: githubToken }) };
    const context = actionContext(run);
    const result =
      frame.secrets === "inherit"
        ? { ...available }
        : record(
            evaluateTemplate(frame.secrets, {
              ...context,
              github: { ...context.github, token: githubToken ?? "" },
              ...frame.caller,
              secrets: available,
            }),
          );
    for (const [name, value] of Object.entries(
      record(record(source.plan.triggers.workflow_call).secrets),
    ))
      if (record(value).required === true && !result[name])
        throw new ValidationError(`Required workflow secret ${name} is missing`);
    secrets = Object.fromEntries(
      Object.entries(result).map(([name, value]) => [name, String(value ?? "")]),
    );
    delete secrets.GITHUB_TOKEN;
  }
  return secrets;
}
