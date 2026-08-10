/**
 * @module pending-actions
 *
 * "What is waiting on a human here, and what exactly do they do about it?"
 *
 * Openship already knew all of this — it just never said it in one place. The
 * signals were scattered across an SSE session held in memory (a live decision
 * prompt), two flags derived from the active deployment's `meta`
 * (`awaitingDecision`, `routingUnsynced`), a failed deployment row, and the
 * domain table (unverified DNS, a broken cert). The dashboard rendered four
 * independent conditional banners on one tab plus per-domain hints on another,
 * and an API client could see none of it.
 *
 * Two things follow from having one list:
 *
 *   1. A blocked deploy stops disappearing. It fails, and a failed deploy never
 *      becomes `activeDeploymentId` — so every existing "needs attention" flag,
 *      all of which read the ACTIVE deployment, was structurally unable to see
 *      it. This reads the LATEST deployment too.
 *
 *   2. Each item carries its own resolution as data (`resolveWith`), so a caller
 *      does not have to know that a port-conflict prompt is answered with the
 *      literal action id "free_port". That was previously undiscoverable: the
 *      responder endpoint was exposed while the payload naming the ids was not.
 *
 * Read-only and side-effect free. Computed on demand, NOT folded into the project
 * read payload, matching how the other attention data works (`/commit-status`,
 * `/port-check`, `/routing/edge-status`) — so the hot list/detail reads pay
 * nothing for it.
 */

import { repos } from "@repo/db";
import type { Deployment } from "@repo/db";
import * as sessionManager from "../deployments/session-manager";
// Leaf import, not the ./compose barrel — this needs one pure predicate over
// `project.framework`, not the whole compose pipeline in the graph.
import { isMultiServiceProject } from "../deployments/compose/project-services";
import { deploymentIsInFlight, deploymentRoutingUnsynced } from "./deployment-flags";

// ─── Shape ──────────────────────────────────────────────────────────────────

export type PendingActionKind =
  /** A deploy failed on a named, clearable cause (status `action_required`). */
  | "deploy_blocked"
  /** A deploy is HELD right now, waiting for a decision, and will abort if unanswered. */
  | "prompt"
  /** A partial-failure release awaiting keep/reject. */
  | "partial_decision"
  /** Live, but the managed edge route didn't sync. */
  | "routing_unsynced"
  /** A custom domain whose DNS hasn't verified. */
  | "domain_unverified"
  /** A certificate that errored or expired. */
  | "ssl_error"
  /** Advisory: the app doesn't appear to be listening where routing points. */
  | "port_advisory";

export interface PendingActionResolution {
  /** Human label — also the natural thing for an agent to echo before acting. */
  label: string;
  /** Has a side effect a user would want to confirm (kills a process, tears down). */
  destructive?: boolean;
  method: "POST" | "DELETE";
  /** Concrete path, params already substituted — callable as-is. */
  path: string;
  body?: Record<string, unknown>;
}

export interface PendingAction {
  /** Stable for the same underlying condition, so a client can de-dupe across polls. */
  id: string;
  kind: PendingActionKind;
  /**
   * `action_required` — someone must act or this stays broken.
   * `advisory` — probably wrong, safe to dismiss. Kept in the same list so a
   * caller sees everything, but never escalated to a blocker.
   */
  severity: "action_required" | "advisory";
  title: string;
  message: string;
  details?: Record<string, unknown>;
  /** Only on `prompt`: when the hold gives up and the deploy aborts. */
  expiresAt?: string;
  resolveWith: PendingActionResolution[];
}

/** Blockers before advisories; within a tier, insertion order (deploy first). */
function bySeverity(a: PendingAction, b: PendingAction): number {
  const rank = (s: PendingAction["severity"]) => (s === "action_required" ? 0 : 1);
  return rank(a.severity) - rank(b.severity);
}

// ─── Builders, one per source ───────────────────────────────────────────────

type DeployMeta = {
  composeDeployment?: { decision?: string; failedServiceNames?: string[] };
  edgeUnsynced?: boolean;
  deployWarning?: string;
  portCheck?: Array<{
    port?: number;
    serviceId?: string;
    serviceName?: string;
    checked?: boolean;
    listening?: boolean;
  }> | null;
  /**
   * Dismissed advisories. Heterogeneous ON PURPOSE — `skipPortCheck` persists the
   * caller's `target` verbatim, and the UI sends a service id (string) for a
   * compose project and a PORT (number) for a single-app one. Typing this as
   * `string[]` and comparing stringified ports silently never matched, so a
   * dismissed advisory came back on every poll.
   */
  portCheckSkipped?: (number | string)[];
} | null;

/**
 * A deploy that failed on something the operator can clear.
 *
 * The copy branches on `isManagedDeployment`, which is the difference between an
 * action someone can take confidently and one they should think about: a stale
 * Openship deployment holding the port is ours to stop, while an unrelated
 * process on the box is not something we should imply is safe to kill.
 *
 * The resolution is redeploy, not "resume" — `onFailure` destroys the build
 * artifact on every failure path, so there is nothing to resume. Redeploying
 * re-runs preflight, which raises the port prompt again; that prompt is then a
 * `prompt` item in this same list, with `free_port` as one of its resolutions.
 */
function buildDeployBlocked(dep: Deployment): PendingAction | null {
  const details = (dep.errorDetails ?? {}) as {
    port?: number;
    pid?: number;
    command?: string;
    isManagedDeployment?: boolean;
  };
  const redeploy: PendingActionResolution = {
    label: "Redeploy",
    method: "POST",
    path: `/api/deployments/${dep.id}/redeploy`,
  };

  if (dep.errorCode === "PORT_IN_USE") {
    // `port` can be absent (a row classified before details were persisted), and
    // `isManagedDeployment` is THREE-valued: the nohup supervisor's PORT_IN_USE
    // carries only {port, pid, command}, so `undefined` means "we didn't probe
    // ownership" — NOT "not ours". Claiming a process isn't Openship's when we
    // don't know would tell the operator it's unsafe to free something that is
    // in fact a stale deployment of their own.
    const subject = details.port ? `Port ${details.port}` : "The port";
    const holder = details.command ?? "another process";
    const ownership =
      details.isManagedDeployment === true
        ? `${subject} is held by a previous Openship deployment (${holder}). ` +
          `Redeploy and choose "Free Port & Continue" when asked, and Openship will stop it first.`
        : details.isManagedDeployment === false
          ? `${subject} is held by ${holder}, which Openship does not manage. ` +
            `Stop it on the server or change the app's port, then redeploy. ` +
            `Redeploying will offer to free the port, but that would kill a process ` +
            `Openship didn't start.`
          : `${subject} is held by ${holder}. Openship could not tell whether that is ` +
            `one of its own previous deployments, so check before freeing it — ` +
            `redeploying will offer to, and that kills the process either way.`;
    return {
      id: `deploy_blocked:${dep.id}`,
      kind: "deploy_blocked",
      severity: "action_required",
      title: details.port ? `Port ${details.port} is in use` : "A required port is in use",
      message: ownership,
      details,
      resolveWith: [redeploy],
    };
  }

  // Any other blocking code (see blocking-errors). Unreachable today; here so a
  // widened set degrades to something honest instead of silently vanishing.
  return {
    id: `deploy_blocked:${dep.id}`,
    kind: "deploy_blocked",
    severity: "action_required",
    title: "Deploy blocked",
    message: dep.errorMessage ?? "The last deploy stopped on a condition that needs attention.",
    details: { ...details, errorCode: dep.errorCode },
    resolveWith: [redeploy],
  };
}

/**
 * A deploy HELD right now on a decision. The only item with a deadline: if
 * nobody answers, the pipeline aborts (see PROMPT_TIMEOUT_MS).
 *
 * Every action the prompt offers becomes a resolution carrying the exact body,
 * so the caller never has to know the action ids.
 */
function buildPrompt(dep: Deployment): PendingAction | null {
  // Only a deploy that is still MOVING can be waiting on an answer. The session
  // clears its held prompt on respond/timeout/teardown, so this is belt-and-
  // braces — but the contradiction it rules out is a bad one: "answer this or the
  // deploy aborts" printed against a deploy that already aborted, whose answer
  // would go nowhere (respondToPrompt matches nothing and silently returns false).
  if (!deploymentIsInFlight(dep)) return null;
  const prompt = sessionManager.getSession(dep.id)?.currentPrompt;
  if (!prompt) return null;
  const deploymentId = dep.id;
  return {
    id: `prompt:${deploymentId}:${prompt.promptId}`,
    kind: "prompt",
    severity: "action_required",
    title: prompt.title,
    message: prompt.message,
    details: prompt.details,
    expiresAt: prompt.expiresAt,
    resolveWith: prompt.actions.map((a) => ({
      label: a.label,
      destructive: a.variant === "danger",
      method: "POST" as const,
      path: `/api/deployments/${deploymentId}/build/respond`,
      body: { action: a.id },
    })),
  };
}

/** A partial-failure release still awaiting keep/reject. */
function buildPartialDecision(dep: Deployment): PendingAction | null {
  const meta = dep.meta as DeployMeta;
  if (meta?.composeDeployment?.decision !== "pending") return null;
  const failed = meta.composeDeployment.failedServiceNames ?? [];
  return {
    id: `partial_decision:${dep.id}`,
    kind: "partial_decision",
    severity: "action_required",
    title: "Some services failed — keep or reject this release",
    message:
      (failed.length
        ? `These services failed: ${failed.join(", ")}. `
        : "Some services failed to come up. ") +
      "The rest are live. Keep the release, or reject it to roll back to the previous one.",
    details: { failedServiceNames: failed },
    resolveWith: [
      { label: "Keep", method: "POST", path: `/api/deployments/${dep.id}/keep` },
      {
        label: "Reject and roll back",
        destructive: true,
        method: "POST",
        path: `/api/deployments/${dep.id}/reject`,
      },
    ],
  };
}

/**
 * Live, but the managed edge route didn't sync — the app may not be reachable.
 *
 * The test is `deploymentRoutingUnsynced`, shared with the project-card flag, so
 * the badge and this list can never disagree about whether there is anything to
 * do (they briefly did, on an empty-string `deployWarning`).
 */
function buildRoutingUnsynced(projectId: string, dep: Deployment): PendingAction | null {
  if (!deploymentRoutingUnsynced(dep)) return null;
  const meta = dep.meta as DeployMeta;
  const warning = meta?.deployWarning || undefined;
  return {
    id: `routing_unsynced:${projectId}`,
    kind: "routing_unsynced",
    severity: "action_required",
    title: "Routing didn't sync",
    message:
      warning ??
      "The deploy succeeded but its edge route didn't sync, so the public URL may not resolve yet. Retrying re-runs just the routing step — it does not rebuild.",
    resolveWith: [
      { label: "Retry routing", method: "POST", path: `/api/projects/${projectId}/routing/retry` },
    ],
  };
}

type DomainRow = Awaited<ReturnType<typeof repos.domain.listByProject>>[number];

/**
 * DNS that hasn't verified, and certificates that failed.
 *
 * `verifyAttempts` matters: one failure is normal DNS propagation, repeated
 * failures mean it's misconfigured — so it rides along in the details rather
 * than the message pretending to know which it is. `lastVerifyError` is the
 * server's own diagnosis (summarizeCertbotFailure already maps a failed issuance
 * to "DNS not resolving" / ":80 firewalled" / "proxy 404"), so it is surfaced
 * verbatim instead of being re-guessed here.
 */
function buildDomainActions(domains: DomainRow[]): PendingAction[] {
  const out: PendingAction[] = [];
  for (const d of domains) {
    if (d.status === "removing") continue;

    if (d.verified === false || d.status === "failed") {
      out.push({
        id: `domain_unverified:${d.id}`,
        kind: "domain_unverified",
        severity: "action_required",
        title: `${d.hostname} isn't verified`,
        message:
          d.lastVerifyError ??
          "DNS for this hostname hasn't verified yet. Check the records, then re-run the check.",
        details: {
          hostname: d.hostname,
          status: d.status,
          verifyAttempts: d.verifyAttempts,
          lastVerifyError: d.lastVerifyError,
        },
        resolveWith: [
          { label: "Verify DNS", method: "POST", path: `/api/domains/${d.id}/verify` },
          {
            label: "Remove this route",
            destructive: true,
            method: "DELETE",
            path: `/api/domains/${d.id}`,
          },
        ],
      });
      // An unverified hostname has no cert yet by definition — reporting an SSL
      // problem too would be two items for one cause.
      continue;
    }

    if (d.sslStatus === "error" || d.sslStatus === "expired") {
      out.push({
        id: `ssl_error:${d.id}`,
        kind: "ssl_error",
        severity: "action_required",
        title:
          d.sslStatus === "expired"
            ? `The certificate for ${d.hostname} expired`
            : `The certificate for ${d.hostname} failed`,
        message:
          d.lastVerifyError ??
          "HTTPS will fail for this hostname until a certificate is issued. Renewing re-runs issuance.",
        details: { hostname: d.hostname, sslStatus: d.sslStatus },
        resolveWith: [
          { label: "Renew certificate", method: "POST", path: `/api/domains/${d.id}/renew` },
          { label: "Re-check certificate", method: "POST", path: `/api/domains/${d.id}/verify-ssl` },
        ],
      });
    }
  }
  return out;
}

/**
 * Advisory: after deploying, the app wasn't listening where routing points.
 *
 * Stays `advisory` on purpose — the probe has a 5s budget and degrades to
 * "unknown", so it is a strong hint, not proof. Dismissing it is a legitimate
 * outcome (that is what skip-port-check records).
 */
function buildPortAdvisories(dep: Deployment, isCompose: boolean): PendingAction[] {
  const meta = dep.meta as DeployMeta;
  const skipped = meta?.portCheckSkipped ?? [];
  return (meta?.portCheck ?? [])
    .filter((r) => r.checked && r.listening === false)
    // Mirrors `skipTarget` in PortAdvisoryModal EXACTLY — service id only for a
    // compose project, otherwise the raw numeric port. Getting this wrong breaks
    // dismissal in both directions: we'd re-surface something already dismissed,
    // and the target WE hand back would be one the dashboard's own matcher never
    // recognises, so its modal would keep nagging too.
    .map((r) => ({ r, target: isCompose && r.serviceId ? r.serviceId : (r.port as number) }))
    .filter(({ target }) => !skipped.includes(target))
    .map(({ r, target }) => ({
      id: `port_advisory:${dep.id}:${target}`,
      kind: "port_advisory" as const,
      severity: "advisory" as const,
      title: `Nothing is listening on port ${r.port}`,
      message:
        `${r.serviceName ?? "The app"} was expected on port ${r.port}, but nothing answered there. ` +
        `If it listens on a different port, update the project's port; if this is wrong, dismiss it.`,
      details: { port: r.port, serviceId: r.serviceId, serviceName: r.serviceName },
      resolveWith: [
        {
          label: "Dismiss",
          method: "POST" as const,
          path: `/api/deployments/${dep.id}/skip-port-check`,
          body: { target },
        },
      ],
    }));
}

// ─── Entry points ───────────────────────────────────────────────────────────

type ProjectRow = NonNullable<Awaited<ReturnType<typeof repos.project.findById>>>;

/**
 * The pure core: rows in, items out, no I/O.
 *
 * Split out from the loader so an org-wide caller can BULK-load the same three
 * things once for every project and reuse this — otherwise a global feed costs
 * 3 queries per project. Every entry point below funnels through here, which is
 * what makes it structurally impossible for the project tab, a deployment view
 * and the global tracker to describe one condition differently.
 */
export function collectPendingActions(input: {
  project: ProjectRow;
  latest: Deployment | null;
  active: Deployment | null;
  domains: DomainRow[];
}): PendingAction[] {
  const { project, latest, active, domains } = input;
  const actions: PendingAction[] = [];

  // Deploy-side, from the LATEST attempt.
  if (latest) {
    const prompt = buildPrompt(latest);
    if (prompt) actions.push(prompt);
    if (latest.status === "action_required") {
      const blocked = buildDeployBlocked(latest);
      if (blocked) actions.push(blocked);
    }
  }

  // Release-side, from the LIVE deployment.
  if (active) {
    const decision = buildPartialDecision(active);
    if (decision) actions.push(decision);
    const routing = buildRoutingUnsynced(project.id, active);
    if (routing) actions.push(routing);
    actions.push(...buildPortAdvisories(active, isMultiServiceProject(project)));
  }

  actions.push(...buildDomainActions(domains));
  return actions.sort(bySeverity);
}

/**
 * Everything waiting on a human for one project.
 *
 * Reads BOTH the latest deployment (a blocked deploy, a live prompt — neither of
 * which is ever the active one) and the active deployment (decisions and routing
 * state, which are properties of the live release), because those are genuinely
 * different questions and either can be outstanding on its own.
 */
export async function getProjectPendingActions(
  projectId: string,
  organizationId: string,
): Promise<PendingAction[]> {
  const project = await repos.project.findById(projectId);
  if (!project || project.organizationId !== organizationId) return [];

  const [latest, active, domains] = await Promise.all([
    repos.deployment.findLatestByProject(projectId).catch(() => null),
    project.activeDeploymentId
      ? repos.deployment.findById(project.activeDeploymentId).catch(() => null)
      : Promise.resolve(null),
    repos.domain.listByProject(projectId).catch(() => []),
  ]);

  return collectPendingActions({ project, latest: latest ?? null, active: active ?? null, domains });
}

/**
 * The same items for EVERY project in an organization — what the global issue
 * tracker reads.
 *
 * Bulk-loads with repo methods that already exist, so the cost is a fixed handful
 * of queries no matter how many projects the org has, not 3×N. The per-project
 * verdict is `collectPendingActions`, unchanged — a condition that shows up on a
 * project's own tab shows up here, worded identically, or it's a bug.
 *
 * Items are returned keyed by project so the caller can attach a target without
 * re-deriving which project an item's paths belong to.
 */
export async function getOrgPendingActions(
  organizationId: string,
): Promise<Map<string, PendingAction[]>> {
  const { rows: projects } = await repos.project.listByOrganization(organizationId, {
    perPage: 1000,
  });
  const out = new Map<string, PendingAction[]>();
  if (projects.length === 0) return out;

  const ids = projects.map((p) => p.id);
  const activeIds = projects.map((p) => p.activeDeploymentId).filter((id): id is string => !!id);

  const [latestByProject, activeById, domainsByProject] = await Promise.all([
    repos.deployment.findLatestByProjects(ids).catch(() => new Map<string, Deployment>()),
    repos.deployment.findManyById(activeIds).catch(() => new Map<string, Deployment>()),
    repos.domain.listByProjects(ids).catch(() => new Map<string, DomainRow[]>()),
  ]);

  for (const project of projects) {
    const items = collectPendingActions({
      project,
      latest: latestByProject.get(project.id) ?? null,
      active: project.activeDeploymentId
        ? (activeById.get(project.activeDeploymentId) ?? null)
        : null,
      domains: domainsByProject.get(project.id) ?? [],
    });
    if (items.length > 0) out.set(project.id, items);
  }
  return out;
}

/**
 * The same items, scoped to ONE deployment — what a client watching a specific
 * deploy needs. Uses the identical builders, so the two views cannot describe the
 * same condition differently.
 */
export async function getDeploymentPendingActions(
  deploymentId: string,
  organizationId: string,
): Promise<PendingAction[]> {
  const dep = await repos.deployment.findById(deploymentId);
  if (!dep || dep.organizationId !== organizationId) return [];
  // Needed only to pick the right dismissal target for a port advisory (service
  // id for compose, port otherwise) — see buildPortAdvisories.
  const project = await repos.project.findById(dep.projectId).catch(() => null);

  const actions: PendingAction[] = [];
  const prompt = buildPrompt(dep);
  if (prompt) actions.push(prompt);
  if (dep.status === "action_required") {
    const blocked = buildDeployBlocked(dep);
    if (blocked) actions.push(blocked);
  }
  const decision = buildPartialDecision(dep);
  if (decision) actions.push(decision);
  if (project) actions.push(...buildPortAdvisories(dep, isMultiServiceProject(project)));
  return actions.sort(bySeverity);
}
