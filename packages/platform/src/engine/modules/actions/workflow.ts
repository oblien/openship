import {
  convertWorkflowTemplate,
  NoOperationTraceWriter,
  parseWorkflow,
} from "@actions/workflow-parser";
import { parseDocument } from "yaml";
import { isDeepStrictEqual } from "node:util";
import cronParser from "cron-parser";
import {
  ACTIONS_MAX_JOBS,
  ACTIONS_MAX_WORKFLOW_BYTES,
  ValidationError,
  type ActionJobDefinition,
  type ActionJobSpec,
  type ActionNeedsResult,
  type ActionWorkflowPlan,
} from "@repo/core";
import { evaluateTemplate, type ActionExpressionContext } from "./expressions";

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function unsupported(field: string): never {
  throw new ValidationError(
    `${field} is not supported by OpenShip Actions yet. Remove it or run this workflow on GitHub; it will not be silently ignored.`,
  );
}

/** GitHub's parser owns syntax/context validation. Our checks cover controller capabilities. */
export async function parseActionWorkflow(
  source: string,
  path = ".github/workflows/ci.yml",
): Promise<ActionWorkflowPlan> {
  if (!source.trim() || Buffer.byteLength(source) > ACTIONS_MAX_WORKFLOW_BYTES)
    throw new ValidationError(
      `Workflow must be between 1 byte and ${ACTIONS_MAX_WORKFLOW_BYTES / 1024} KiB`,
    );
  const parsed = parseWorkflow({ name: path, content: source }, new NoOperationTraceWriter());
  if (parsed.value) await convertWorkflowTemplate(parsed.context, parsed.value);
  const errors = parsed.context.errors.getErrors();
  if (errors.length)
    throw new ValidationError(
      errors
        .slice(0, 8)
        .map((e) => e.message)
        .join("\n"),
    );
  const doc = parseDocument(source, { uniqueKeys: true });
  if (doc.errors.length) throw new ValidationError(doc.errors[0]!.message);
  const raw = record(doc.toJS({ maxAliasCount: 0 }));
  const triggers =
    typeof raw.on === "string"
      ? { [raw.on]: {} }
      : Array.isArray(raw.on)
        ? Object.fromEntries(raw.on.map((e) => [String(e), {}]))
        : record(raw.on);
  for (const trigger of Object.keys(triggers)) {
    if (
      !["push", "pull_request", "workflow_dispatch", "schedule", "repository_dispatch"].includes(
        trigger,
      )
    )
      unsupported(`on.${trigger}`);
  }
  if (triggers.schedule !== undefined) {
    if (
      !Array.isArray(triggers.schedule) ||
      !triggers.schedule.length ||
      triggers.schedule.length > 20
    )
      throw new ValidationError("Specify 1–20 workflow schedules");
    for (const entry of triggers.schedule) {
      const cron = record(entry).cron;
      if (typeof cron !== "string" || cron.trim().split(/\s+/).length !== 5)
        throw new ValidationError("Workflow schedules require five-field UTC cron expressions");
      const minutes = [...cronParser.parseExpression(cron, { tz: "UTC" }).fields.minute]
        .map(Number)
        .sort((a, b) => a - b);
      if (
        minutes.some(
          (minute, index) =>
            minutes[(index + 1) % minutes.length]! +
              (index + 1 === minutes.length ? 60 : 0) -
              minute <
            5,
        )
      )
        throw new ValidationError("Workflow schedules must be at least five minutes apart");
      if (Object.keys(record(entry)).some((key) => key !== "cron"))
        unsupported("on.schedule options other than cron");
    }
  }
  if (record(raw.concurrency).queue) unsupported("concurrency.queue");
  const jobs = Object.entries(record(raw.jobs)).map(([id, value]): ActionJobDefinition => {
    const job = record(value);
    if (job.uses) unsupported(`jobs.${id}.uses (reusable workflows)`);
    if (job.environment) unsupported(`jobs.${id}.environment (protected environments)`);
    if (record(job.concurrency).queue) unsupported(`jobs.${id}.concurrency.queue`);
    if (job.snapshot) unsupported(`jobs.${id}.snapshot`);
    const steps = Array.isArray(job.steps) ? job.steps.map(record) : [];
    for (const step of steps) {
      for (const key of ["background", "wait", "wait-all", "parallel", "cancel"])
        if (key in step) unsupported(`jobs.${id}.steps.${key}`);
    }
    const strategy = record(job.strategy);
    return {
      id,
      name: typeof job.name === "string" ? job.name : id,
      needs:
        typeof job.needs === "string"
          ? [job.needs]
          : Array.isArray(job.needs)
            ? job.needs.map(String)
            : [],
      runsOn: job["runs-on"],
      condition: job.if as string | boolean | undefined,
      matrix: strategy.matrix,
      failFast: strategy["fail-fast"] ?? true,
      maxParallel: strategy["max-parallel"] ?? ACTIONS_MAX_JOBS,
      timeoutMinutes: job["timeout-minutes"] ?? 60,
      continueOnError: job["continue-on-error"] ?? false,
      concurrency: job.concurrency,
      permissions: job.permissions,
      requiresDocker:
        !!job.container ||
        Object.keys(record(job.services)).length > 0 ||
        steps.some((s) => typeof s.uses === "string" && s.uses.startsWith("docker://")),
    };
  });
  if (!jobs.length || jobs.length > ACTIONS_MAX_JOBS)
    throw new ValidationError(`A workflow requires 1–${ACTIONS_MAX_JOBS} jobs`);
  // Validation also protects imported/edited YAML against cycles before any side effect.
  const byId = new Map(jobs.map((job) => [job.id, job]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new ValidationError(`Job dependency cycle at ${id}`);
    if (visited.has(id)) return;
    const job = byId.get(id);
    if (!job) throw new ValidationError(`Unknown dependency ${id}`);
    visiting.add(id);
    job.needs.forEach(visit);
    visiting.delete(id);
    visited.add(id);
  };
  jobs.forEach((j) => visit(j.id));
  actionPermissions(raw.permissions);
  jobs.forEach((job) => {
    if (job.permissions !== undefined) actionPermissions(job.permissions);
  });
  return {
    name: typeof raw.name === "string" ? raw.name : path,
    triggers,
    jobs,
    concurrency: raw.concurrency,
    permissions: raw.permissions,
  };
}

const same = isDeepStrictEqual;
export function expandMatrix(value: unknown): Record<string, unknown>[] {
  if (value === undefined || value === null) return [{}];
  if (typeof value !== "object" || Array.isArray(value))
    throw new ValidationError("strategy.matrix must evaluate to an object");
  const matrix = record(value);
  const axes = Object.entries(matrix).filter(([key]) => key !== "include" && key !== "exclude");
  let rows: Record<string, unknown>[] = [{}];
  for (const [key, values] of axes) {
    if (!Array.isArray(values) || !values.length)
      throw new ValidationError(`Matrix axis ${key} must be a non-empty array`);
    if (rows.length * values.length > ACTIONS_MAX_JOBS)
      throw new ValidationError(`Matrix expands beyond ${ACTIONS_MAX_JOBS} jobs`);
    rows = rows.flatMap((row) => values.map((value) => ({ ...row, [key]: value })));
  }
  const excluded = matrix.exclude ?? [];
  const included = matrix.include ?? [];
  if (
    !Array.isArray(excluded) ||
    !Array.isArray(included) ||
    [...excluded, ...included].some((v) => !v || typeof v !== "object" || Array.isArray(v))
  )
    throw new ValidationError("Matrix include/exclude must contain objects");
  rows = rows.filter(
    (row) =>
      !excluded.some((ex) => Object.entries(ex).every(([key, value]) => same(row[key], value))),
  );
  const originals = rows.map((row) => ({ ...row }));
  const additions: Record<string, unknown>[] = [];
  for (const include of included) {
    let matched = false;
    if (axes.length)
      originals.forEach((original, index) => {
        if (
          Object.entries(include).every(
            ([key, value]) => !(key in original) || same(original[key], value),
          )
        ) {
          rows[index] = { ...rows[index], ...include };
          matched = true;
        }
      });
    if (!matched) additions.push({ ...include });
  }
  if (!axes.length && included.length) rows = [];
  const result = [...rows, ...additions];
  if (result.length > ACTIONS_MAX_JOBS)
    throw new ValidationError(`Matrix expands beyond ${ACTIONS_MAX_JOBS} jobs`);
  return result;
}

export function actionConcurrency(
  value: unknown,
  ctx: ActionExpressionContext,
): ActionJobSpec["concurrency"] {
  if (value === undefined || value === null) return null;
  const evaluated = evaluateTemplate(value, ctx);
  const concurrency = typeof evaluated === "string" ? { group: evaluated } : record(evaluated);
  if (
    typeof concurrency.group !== "string" ||
    !concurrency.group.trim() ||
    concurrency.group.length > 256
  )
    throw new ValidationError(
      "Concurrency group must be a non-empty string of at most 256 characters",
    );
  if (
    concurrency["cancel-in-progress"] !== undefined &&
    typeof concurrency["cancel-in-progress"] !== "boolean"
  )
    throw new ValidationError("cancel-in-progress must evaluate to a boolean");
  return {
    group: concurrency.group.toLowerCase(),
    cancelInProgress: concurrency["cancel-in-progress"] === true,
  };
}

// Permission names supported by GitHub App installation tokens. OIDC/attestation
// identity cannot be emulated with an installation token; fail before executing.
const permissionNames = [
  "actions",
  "checks",
  "contents",
  "deployments",
  "discussions",
  "issues",
  "packages",
  "pull-requests",
  "repository-projects",
  "security-events",
  "statuses",
];
export function actionPermissions(value: unknown): ActionJobSpec["permissions"] {
  if (value === undefined) return { contents: "read" };
  if (value === "read-all")
    return Object.fromEntries(permissionNames.map((name) => [name, "read" as const]));
  if (value === "write-all") unsupported("permissions: write-all (request individual permissions)");
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ValidationError("Invalid workflow permissions");
  const result: ActionJobSpec["permissions"] = {};
  for (const [key, access] of Object.entries(value)) {
    if (access === "none") continue;
    if (!permissionNames.includes(key)) unsupported(`permissions.${key}`);
    if (access !== "read" && access !== "write")
      throw new ValidationError(`Invalid permission ${key}`);
    result[key] = access;
  }
  return result;
}

export function concreteJob(
  job: ActionJobDefinition,
  matrix: Record<string, unknown>,
  ctx: ActionExpressionContext,
  workflow: ActionWorkflowPlan,
): ActionJobSpec {
  const context = { ...ctx, matrix };
  const runsOn = evaluateTemplate(job.runsOn, context);
  if (runsOn && typeof runsOn === "object" && !Array.isArray(runsOn)) unsupported("runs-on groups");
  const labels = typeof runsOn === "string" ? [runsOn] : runsOn;
  if (
    !Array.isArray(labels) ||
    !labels.length ||
    labels.some((l) => typeof l !== "string" || !l.trim() || l.length > 100)
  )
    throw new ValidationError(`${job.id}: runs-on must resolve to runner labels`);
  const timeout = evaluateTemplate(job.timeoutMinutes, context);
  const parallel = evaluateTemplate(job.maxParallel, context);
  const failFast = evaluateTemplate(job.failFast, context);
  const continueOnError = evaluateTemplate(job.continueOnError, context);
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0 || timeout > 360)
    throw new ValidationError(`${job.id}: timeout-minutes must be between 0 and 360`);
  if (
    typeof parallel !== "number" ||
    !Number.isSafeInteger(parallel) ||
    parallel < 1 ||
    parallel > ACTIONS_MAX_JOBS
  )
    throw new ValidationError(`${job.id}: max-parallel must be between 1 and ${ACTIONS_MAX_JOBS}`);
  if (typeof failFast !== "boolean" || typeof continueOnError !== "boolean")
    throw new ValidationError(
      `${job.id}: fail-fast and continue-on-error must evaluate to booleans`,
    );
  const baseName = String(evaluateTemplate(job.name, context));
  const suffix = Object.values(matrix)
    .map((v) => (typeof v === "object" ? JSON.stringify(v) : String(v)))
    .join(", ");
  return {
    jobId: job.id,
    name: suffix && !job.name.includes("${{") ? `${baseName} (${suffix})` : baseName,
    matrix,
    labels: labels.map((l) => l.toLowerCase()),
    needs: (ctx.needs ?? {}) as Record<string, ActionNeedsResult>,
    strategy: {
      "job-index": Number(record(ctx.strategy)["job-index"] ?? 0),
      "job-total": Number(record(ctx.strategy)["job-total"] ?? 1),
      "fail-fast": failFast,
      "max-parallel": parallel,
    },
    timeoutSeconds: Math.ceil(timeout * 60),
    maxParallel: parallel,
    failFast,
    continueOnError,
    concurrency: actionConcurrency(job.concurrency, context),
    permissions: actionPermissions(job.permissions ?? workflow.permissions),
    requiresDocker: job.requiresDocker,
  };
}
