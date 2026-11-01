import { createHash } from "node:crypto";
import {
  AppError,
  ValidationError,
  actionRunnerAdmissionKey,
  type ActionAccessPolicy,
  type ActionActorIdentity,
  type ActionRunAdmission,
} from "@repo/core";
import type { CreateActionWorkflow } from "@repo/contracts";
import { repos, type ActionRun, type ActionWorkflow } from "@repo/db";
import type { ExecutionContext } from "../../../context";
import { getUserStatus } from "../github/github.auth";
import { GitHubActionsApi } from "./github-api";

export function githubActionActor(
  value: { id?: number; login: string } | null | undefined,
): ActionActorIdentity | null {
  return value && Number.isSafeInteger(value.id) && value.id! > 0 && value.login
    ? { provider: "github", id: String(value.id), login: value.login }
    : null;
}

export async function actionCallerIdentity(
  ctx: ExecutionContext,
  repository: boolean,
): Promise<ActionActorIdentity> {
  if (!repository)
    return { provider: "openship", id: ctx.userId, login: ctx.user.name || ctx.userId };
  const status = await getUserStatus(ctx.userId, ctx);
  const identity = status.connected
    ? githubActionActor({ id: Number(status.id), login: status.login })
    : null;
  if (!identity)
    throw new AppError(
      "Connect your personal GitHub account to use Only my account, or select specific GitHub users.",
      409,
      "ACTIONS_GITHUB_IDENTITY_REQUIRED",
    );
  return identity;
}

export async function prepareActionAccessPolicy(
  ctx: ExecutionContext,
  input: CreateActionWorkflow,
  existing?: ActionWorkflow,
): Promise<ActionAccessPolicy> {
  const sameRepository =
    existing?.owner === (input.owner?.toLowerCase() ?? null) &&
    existing?.repo === (input.repo?.toLowerCase() ?? null);
  if (!input.accessPolicy && existing?.accessPolicy && sameRepository) return existing.accessPolicy;
  const requested = input.accessPolicy ?? {
    audience: "owner",
    users: [],
    approval: "required",
    forks: "deny",
  };
  if (requested.audience === "selected" && (!input.owner || !requested.users.length))
    throw new ValidationError("Choose at least one GitHub user for selected-user access");
  const owner =
    sameRepository && existing?.accessPolicy
      ? existing.accessPolicy.owner
      : requested.audience === "owner"
        ? await actionCallerIdentity(ctx, !!input.owner)
        : { provider: "openship" as const, id: ctx.userId, login: ctx.user.name || ctx.userId };
  // Switching an older collaborators policy to Only my account resolves the
  // editor's personal identity, never an installation or organization name.
  const principal =
    requested.audience === "owner" && !!input.owner && owner.provider !== "github"
      ? await actionCallerIdentity(ctx, true)
      : owner;
  const users: ActionActorIdentity[] = [];
  if (requested.audience === "selected") {
    const api = new GitHubActionsApi(ctx, input.owner!, input.repo!);
    for (const name of [...new Set(requested.users.map((name) => name.toLowerCase()))]) {
      const identity = githubActionActor(await api.user(name));
      if (!identity) throw new ValidationError(`GitHub account ${name} could not be verified`);
      if (!users.some((user) => user.id === identity.id)) users.push(identity);
    }
  }
  return {
    version: 1,
    audience: requested.audience,
    owner: principal,
    users,
    approval: requested.approval,
    forks: input.owner ? requested.forks : "deny",
  };
}

/** This identity comes from GitHub REST or a verified webhook/authenticated
 * controller call, never a user-provided actor name or editable workflow env. */
export async function evaluateActionRunAdmission(
  ctx: ExecutionContext,
  workflow: ActionWorkflow,
  run: Pick<
    ActionRun,
    | "id"
    | "controller"
    | "revision"
    | "attempt"
    | "untrusted"
    | "configuration"
    | "github"
    | "approvedAt"
    | "approvalKey"
    | "eventName"
  >,
): Promise<ActionRunAdmission> {
  const policy = workflow.accessPolicy;
  const actor = run.github?.actor ?? run.configuration.actorIdentity ?? null;
  const triggering = run.github
    ? (run.github.triggeringActor ?? (run.attempt === 1 ? actor : null))
    : run.configuration.triggeringActorIdentity === undefined
      ? actor
      : run.configuration.triggeringActorIdentity;
  const runnerIds = workflow.runnerIds
    .filter((id) => run.controller === "github" || run.configuration.runnerIds.includes(id))
    .sort();
  const runners = await Promise.all(
    runnerIds.map((id) => repos.actions.runner(ctx.organizationId, id)),
  );
  const runnerKeys = Object.fromEntries(
    runners.flatMap((runner) => (runner ? [[runner.id, actionRunnerAdmissionKey(runner)]] : [])),
  );
  // PostgreSQL JSONB reorders object keys. Hash semantic fields in a fixed
  // order so the pre-insert review key survives persistence and refreshes.
  const identityKey = (value: ActionActorIdentity | null) =>
    value ? [value.provider, value.id, value.login] : null;
  const policyKey = policy && [
    policy.version,
    policy.audience,
    identityKey(policy.owner),
    policy.users
      .map((user) => identityKey(user)!)
      .sort((a, b) => a.join(":").localeCompare(b.join(":"))),
    policy.approval,
    policy.forks,
  ];
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        workflow.id,
        workflow.owner,
        workflow.repo,
        workflow.path,
        policyKey,
        [...workflow.runnerIds].sort(),
        runnerKeys,
        run.id,
        run.revision,
        run.attempt,
        identityKey(actor),
        identityKey(triggering),
        run.untrusted,
        run.eventName,
        ...Object.entries(run.configuration.workflows ?? {})
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([id, source]) => [
            id,
            source.sha,
            createHash("sha256").update(source.source).digest("hex"),
          ]),
      ]),
    )
    .digest("hex");
  const result = (
    state: ActionRunAdmission["state"],
    reason: ActionRunAdmission["reason"],
  ): ActionRunAdmission => ({
    state,
    reason,
    key,
    workflowVersion: workflow.updatedAt.toISOString(),
    runnerIds,
    runnerKeys,
  });
  if (!policy) return result("blocked", "policy_missing");
  if (!actor || !triggering) return result("blocked", "identity_unavailable");
  if (run.untrusted && policy.forks !== "review") return result("blocked", "fork_disabled");
  if (!runners.some((runner) => runner?.enabled && (!run.untrusted || runner.cloudPoolId)))
    return result("blocked", "destinations_changed");
  const identities = [actor, triggering];
  const same = (a: ActionActorIdentity, b: ActionActorIdentity) =>
    a.provider === b.provider && a.id === b.id;
  let allowed = false;
  if (policy.audience === "owner") allowed = identities.every((value) => same(value, policy.owner));
  else if (policy.audience === "selected")
    allowed = identities.every((value) => policy.users.some((user) => same(user, value)));
  else if (!workflow.owner)
    allowed = identities.every((value) => value.provider === "openship"); // Existing workspace/destination authorization still applies.
  else {
    const api = new GitHubActionsApi(ctx, workflow.owner, workflow.repo!);
    allowed = true;
    for (const value of identities.filter(
      (value, index) => identities.findIndex((other) => same(other, value)) === index,
    )) {
      if (value.provider !== "github") {
        allowed = false;
        break;
      }
      const permission = await api.collaborator(value.login);
      if (
        String(permission.user.id) !== value.id ||
        !["admin", "write", "maintain"].includes(permission.permission)
      ) {
        allowed = false;
        break;
      }
    }
  }
  if (!allowed) return result("blocked", "actor_not_allowed");
  if (
    (run.untrusted || policy.approval === "required") &&
    (!run.approvedAt || run.approvalKey !== key)
  )
    return result("approval_required", "approval_required");
  return result("allowed", "allowed");
}

export async function refreshActionRunAdmission(
  ctx: ExecutionContext,
  workflow: ActionWorkflow,
  run: ActionRun,
) {
  const admission = await evaluateActionRunAdmission(ctx, workflow, run);
  return repos.actions.setRunAdmission(run.organizationId, run.id, admission, run.updatedAt);
}
