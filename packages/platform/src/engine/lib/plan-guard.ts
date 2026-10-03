/**
 * Plan entitlement gates — the ONE place a plan's limits become a refusal.
 *
 * Paid namespaces use the limits saved with their purchased offer. Free and
 * legacy plans use the pricing catalog (`planLimits(tier)`). Cloud project
 * creation, builds, running services, and resource sizes require the
 * corresponding plan allowances.
 *
 * SCOPE — cloud only, and deliberately `env.CLOUD_MODE`:
 *   Self-hosted Openship is free and unmetered; that's the product promise, so
 *   every gate below returns immediately when CLOUD_MODE is false. It must NOT
 *   use `platform().target` (reads "cloud" for a self-hosted box carrying Oblien
 *   credentials) and must NOT use `requireCloud()` — that helper asserts "this
 *   self-hosted box is CONNECTED to Cloud", which is close to the opposite
 *   question, and its error tells the user to connect Cloud. An over-allowance
 *   org is already connected; sending it to a connect-Cloud modal would "succeed"
 *   and change nothing.
 *
 * Oblien enforces credit limits and subscription suspension. These gates
 * enforce Openship application allowances using the verified subscription.
 */

import {
  AppError,
  FREE_DOMAIN_SUFFIX,
  planLimits,
  planServiceResources,
  resolvePlan,
  RESOURCE_TIER_ORDER,
  RESOURCE_TIER_SPECS,
  formatCpuCores,
  formatMemoryMb,
  type PlanTierId,
  type PlanLimits,
  type OblienLimits,
  type WorkloadType,
} from "@repo/core";
import { repos } from "@repo/db";
import { env } from "../config/env";
import { isCloudManagedHostname } from "./public-endpoints";
import {
  cloudDockerNeedsBuild,
  cloudDockerResources,
  resolveInheritedResources,
  resolveRuntimeResources,
  type CloudServiceResourceInput,
} from "./resources";
import type { ResourceConfig, RuntimeAdapter } from "@repo/adapters";
import { cloudBillingOwner, requireCloudWorkspace, type CloudWorkspaceScope } from "./cloud-workspace-scope";

/**
 * A refusal the user can act on by upgrading. 402 Payment Required is the
 * honest status: the request is well-formed and the caller is authenticated and
 * authorized — it's the plan that's insufficient. A 403 would be
 * indistinguishable from a permissions problem in the dashboard's error mapping.
 */
export class PlanUpgradeRequiredError extends AppError {
  constructor(
    message: string,
    /** Machine-readable reason so a client can pick the right upgrade CTA. */
    public readonly reason:
      | "static-only"
      | "build-minutes-exhausted"
      | "free-subdomain-limit"
      | "resource-tier"
      | "workspace-capacity"
      | "running-services"
      | "project-limit",
    /** The tier that refused, for telemetry and copy. */
    public readonly planTierId: string,
  ) {
    super(message, 402, "PLAN_UPGRADE_REQUIRED");
    this.name = "PlanUpgradeRequiredError";
  }
}

/**
 * The free-subdomain refusal, carrying the slots the org is already using.
 *
 * A subclass rather than an extra message line because the CLIENT needs the list
 * structurally: the dashboard renders each hostname with a Release button, and the
 * CLI prints them. Stuffing ten hostnames into a message string would make the
 * one actionable refusal in the set unparseable.
 */
export class FreeSubdomainLimitError extends PlanUpgradeRequiredError {
  constructor(
    message: string,
    planTierId: string,
    /** Every free subdomain the org currently holds, with its owning project. */
    public readonly slots: FreeSubdomainSlot[],
  ) {
    super(message, "free-subdomain-limit", planTierId);
    this.name = "FreeSubdomainLimitError";
  }
}

/** The org's current tier. Unknown/missing → the catalog's most restrictive. */
async function planFor(organizationId: string, workspaceId?: CloudWorkspaceScope): Promise<{ tier: PlanTierId; limits: PlanLimits; resourceLimits: OblienLimits }> {
  const org = await repos.organization.findById(organizationId);
  const owner = env.CLOUD_MODE ? await cloudBillingOwner(organizationId, workspaceId) : null;
  if (owner?.namespace) {
    const { syncOblienEntitlement } = await import("../modules/billing/billing-oblien-quota");
    // Plan lookups are reads. Token issuance and actual spend operations still
    // synchronize provider resource limits before allowing a workload to start.
    return await syncOblienEntitlement(organizationId, { syncResourceLimits: false, workspaceId: owner.workspaceId });
  }
  const tier = (owner?.planTierId ?? org?.planTierId ?? "free") as PlanTierId;
  return { tier, limits: planLimits(tier), resourceLimits: resolvePlan(tier).oblienLimits };
}

/** The org's tier, for callers that need to name it in their own error. */
export async function currentPlanTier(organizationId: string, workspaceId?: CloudWorkspaceScope): Promise<PlanTierId> {
  return (await planFor(organizationId, workspaceId)).tier;
}

/* ─── Static-only workloads ──────────────────────────────────────────────── */

/**
 * What a deploy will actually run.
 *
 * `workload` is passed in already resolved (via `snapshotToClass` on the frozen
 * snapshot, not the live project row — a rollback must be judged on what it will
 * run) rather than resolved here: this module lives in `lib/` and the class
 * adapters live in `modules/deployments/`, so resolving here would point a leaf
 * at a feature module.
 */
export interface DeployShape {
  workload: WorkloadType;
  /** Service ids this deploy targets; any target means the service pipeline. */
  targetServiceIds?: readonly string[] | null;
  /**
   * Does this deploy go through the multi-service/compose pipeline?
   *
   * A THUNK, not a boolean: answering it fully requires a DB read (a project can
   * have compose service rows without a compose framework), and this gate runs on
   * every deploy including self-hosted ones that exit at the CLOUD_MODE check.
   * Passing it lazily means the query happens only when a tier actually restricts
   * service stacks.
   */
  usesServicePipeline?: () => boolean | Promise<boolean>;
}

/**
 * Refuse a non-static deploy on a static-only tier.
 *
 * Two independent things make a deploy non-static, and BOTH must be checked:
 *
 *  1. `workload !== "static"` — resolved through `snapshotToClass`, the shared
 *     resolver. Never test `productionMode === "static"` (a legacy display
 *     mirror the resolver ignores) and never test `!hasServer` — a portless
 *     `worker` also has `hasServer === false`, so that test reads a worker as
 *     static and lets a container onto cloud compute. That was issue #538-B.
 *
 *  2. The service pipeline — a compose stack, a catalog app, or any deploy that
 *     targets service ids runs containers through `deployComposeServices`
 *     regardless of the parent project's own workload column. A workload-only
 *     check is bypassed by pointing a "static" project at a service.
 */
export async function assertPlanAllowsDeployShape(
  organizationId: string,
  shape: DeployShape,
  workspaceId?: CloudWorkspaceScope,
): Promise<void> {
  if (!env.CLOUD_MODE) return;

  const { tier, limits } = await planFor(organizationId, workspaceId);

  if (!limits.services) {
    const runsServices =
      (shape.targetServiceIds?.length ?? 0) > 0 || (await shape.usesServicePipeline?.()) === true;
    if (runsServices) {
      throw new PlanUpgradeRequiredError(
        "Your plan can deploy static sites only. Multi-service stacks, databases and one-click apps need a paid plan.",
        "static-only",
        tier,
      );
    }
  }

  if (!limits.workloads.includes(shape.workload)) {
    throw new PlanUpgradeRequiredError(
      shape.workload === "worker"
        ? "Your plan can deploy static sites only. Background workers need a paid plan."
        : "Your plan can deploy static sites only. Server-rendered and containerized apps need a paid plan.",
      "static-only",
      tier,
    );
  }
}

/**
 * Refuse a container-provisioning action (adding/starting a managed service,
 * installing a catalog app) on a static-only tier. A provisioned service
 * container is a container by definition, so there is no shape to inspect —
 * these paths never build and never pass through the deploy gate above.
 */
export async function assertPlanAllowsServices(organizationId: string, workspaceId?: CloudWorkspaceScope): Promise<void> {
  if (!env.CLOUD_MODE) return;

  const { tier, limits } = await planFor(organizationId, workspaceId);
  if (!limits.services) {
    throw new PlanUpgradeRequiredError(
      "Your plan can deploy static sites only. Databases, one-click apps and multi-service stacks need a paid plan.",
      "static-only",
      tier,
    );
  }
}

/* ─── Per-service machine size ───────────────────────────────────────────── */

/**
 * Refuse a machine size larger than the tier allows.
 *
 * Oblien enforces the VM and namespace allocation; several Docker services
 * can share one VM. Openship also enforces the selected per-service tier inside
 * that host, so a container cannot silently exceed its service configuration.
 *
 * Named presets and custom sizes are compared on CPU and RAM against the
 * purchased service ceiling, independently of the workspace allocation.
 */
export async function assertPlanAllowsResourceTier(
  organizationId: string,
  requested: { tier?: string | null; cpuCores?: number | null; memoryMb?: number | null },
  workspaceId?: CloudWorkspaceScope,
): Promise<void> {
  if (!env.CLOUD_MODE) return;

  const { tier, limits } = await planFor(organizationId, workspaceId);
  assertResourcesFitPlan(tier, requested, limits);
}

export function assertResourcesFitPlan(
  tier: PlanTierId,
  requested: { tier?: string | null; cpuCores?: number | null; memoryMb?: number | null },
  limits: PlanLimits,
): void {
  const ceiling = planServiceResources(limits);
  if (ceiling === null) return;
  const refuse = (): never => {
    throw new PlanUpgradeRequiredError(
      `Your plan allows up to ${formatCpuCores(ceiling.cpuCores)} and ${formatMemoryMb(ceiling.memoryMb)} RAM per service. Upgrade for bigger machines.`,
      "resource-tier",
      tier,
    );
  };

  // Resolve named presets before comparing; unknown names cannot bypass the cap.
  const requestedTier = requested.tier?.trim();
  let size = requested;
  if (requestedTier === "unlimited") {
    size = { cpuCores: 0, memoryMb: 0 };
  } else if (requestedTier && requestedTier !== "custom") {
    const preset = RESOURCE_TIER_ORDER.find(name => name === requestedTier);
    if (!preset) return refuse();
    size = RESOURCE_TIER_SPECS[preset];
  }

  // Zero adds no container cap: the subscribed server already enforces its
  // allocation. Positive custom limits must still fit that allocation.
  const cpu = size.cpuCores ?? 0;
  const mem = size.memoryMb ?? 0;
  if (!Number.isFinite(cpu) || !Number.isFinite(mem) || cpu < 0 || mem < 0 || cpu > ceiling.cpuCores || mem > ceiling.memoryMb) refuse();
}

type CloudDeploymentLimits = {
  projectId?: string;
  workspaceId?: string;
  resources?: ResourceConfig | Record<string, unknown> | null;
  buildResources?: ResourceConfig | Record<string, unknown> | null;
  runsApplication?: boolean;
  /** A single app may also have separately managed auxiliary services. */
  mainApplication?: boolean;
  /** Internally pinned images use the same no-build decision as the deployer. */
  retainedImages?: Readonly<Record<string, string>>;
  services?: CloudServiceResourceInput[];
};

type CloudServiceAllowance = Pick<CloudDeploymentLimits, "projectId" | "workspaceId" | "runsApplication" | "mainApplication" | "services">;

async function workspaceForProject(organizationId: string, projectId?: string, selectedWorkspaceId?: string) {
  if (!projectId) return (await cloudBillingOwner(organizationId, selectedWorkspaceId)).workspaceId;
  const project = await repos.project.findByIdInOrganization(projectId, organizationId);
  if (!project) throw new AppError("Project not found", 404, "PROJECT_NOT_FOUND");
  if (selectedWorkspaceId && selectedWorkspaceId !== project.workspaceId) throw new AppError("The selected workspace differs from this project", 409, "CLOUD_WORKSPACE_TARGET_CONFLICT");
  return project.workspaceId ?? null;
}

async function assertServiceAllowance(
  organizationId: string,
  tier: PlanTierId,
  input: CloudServiceAllowance,
  limits: PlanLimits,
  workspaceId?: CloudWorkspaceScope,
): Promise<void> {
  const services = input.services?.filter((service) => service.enabled !== false);
  const mainApplication = input.mainApplication ?? (!services && input.runsApplication);
  if (services?.length && !limits.services) {
    throw new PlanUpgradeRequiredError("Your plan can deploy static sites only. Service stacks need a paid plan.", "static-only", tier);
  }
  if (services?.length || input.runsApplication) {
    const limit = limits.runningServices;
    if (limit !== null) {
      // A failed count is unknown, never zero. Include a frozen/imported stack
      // even when its service definitions have not reached the database yet.
      const mainProject = mainApplication ? input.projectId : undefined;
      const prospective = input.projectId && services?.every(service => !!service.name)
        ? { projectId: input.projectId, serviceNames: services.map(service => service.name!) }
        : undefined;
      const counted = await repos.service.countRunningForOrg(organizationId, [], mainProject, prospective, workspaceId);
      const used = mainApplication
        ? counted + 1
        : !input.projectId
          ? counted + (services?.length ?? 1)
          : Math.max(counted, services?.length ?? 1);
      if (used > limit)
        throw new PlanUpgradeRequiredError(
          `Your plan includes ${limit} services. Stop and disable a service, remove it, or upgrade before deploying.`,
          "running-services",
          tier,
        );
    }
  }
}

/** The same slot/plan gate for new deployments and existing-container resumes. */
export async function assertCloudServiceAllowance(organizationId: string, input: CloudServiceAllowance): Promise<void> {
  if (!env.CLOUD_MODE) return;
  const workspaceId = await workspaceForProject(organizationId, input.projectId, input.workspaceId);
  const { tier, limits } = await planFor(organizationId, workspaceId);
  await assertServiceAllowance(organizationId, tier, input, limits, workspaceId);
}

/** Validate the effective configuration on every deployment entry and again
 * immediately before provisioning. Saved config, Compose, updates and rollbacks
 * must obey the same limits as the dashboard's resource picker. */
export async function assertCloudDeploymentLimits(organizationId: string, input: CloudDeploymentLimits): Promise<void> {
  if (!env.CLOUD_MODE) return;
  const workspaceId = await workspaceForProject(organizationId, input.projectId, input.workspaceId);
  const { tier, limits } = await planFor(organizationId, workspaceId);
  await assertServiceAllowance(organizationId, tier, input, limits, workspaceId);
  const services = input.services?.filter(service => service.enabled !== false);
  for (const service of services ?? []) {
    assertResourcesFitPlan(
      tier,
      resolveInheritedResources(service.advanced?.resources, input.resources),
      limits,
    );
  }
  if (input.mainApplication ?? (!services && input.runsApplication)) {
    assertResourcesFitPlan(
      tier,
      resolveRuntimeResources(input.resources),
      limits,
    );
  }
}

/** Starting an existing container applies its OLD limits, not editable settings.
 * Inspect before any start. A stopped Docker workspace cannot be inspected, so
 * only its allocation recorded for this exact container is an acceptable fallback. */
export async function assertCloudRuntimeLimits(organizationId: string,
  runtime: Pick<RuntimeAdapter, "getContainerInfo" | "supports">,
  containers: ReadonlyArray<{ containerId: string;
    allocatedResources?: { containerId: string; cpuCores: number; memoryMb: number } | null }>,
  workspaceId?: CloudWorkspaceScope,
): Promise<void> {
  if (!env.CLOUD_MODE || containers.length === 0) return;
  const { tier, limits } = await planFor(organizationId, workspaceId);
  if (runtime.supports("dockerHost") === false || planServiceResources(limits) === null) return;
  for (const container of containers) {
    const info = await runtime.getContainerInfo(container.containerId);
    const recorded = container.allocatedResources;
    const resources = info?.resources ?? (info?.status === "stopped" && runtime.supports("dockerHost") &&
      recorded?.containerId === container.containerId ? recorded : undefined);
    if (!resources) {
      throw new AppError("Cannot verify this container's resource allocation. Retry when its host is reachable or redeploy it before starting.",
        409, "RESOURCE_LIMITS_UNAVAILABLE");
    }
    assertResourcesFitPlan(tier, resources, limits);
  }
}

/* ─── Projects ───────────────────────────────────────────────────────────── */

/**
 * The tier's project ceiling, or null when the plan doesn't cap them.
 *
 * Openship owns this outright — Oblien has no project concept. Returned rather
 * than asserted because the existing `assertProjectQuota` already counts project
 * groups and raises its own error; it just had no idea a plan existed (every
 * cloud org, free or enterprise, got the same `CLOUD_MAX_PROJECTS_PER_USER` of 2,
 * so a $99 customer was capped at two projects).
 */
export async function planProjectLimit(organizationId: string, workspaceId?: CloudWorkspaceScope): Promise<number | null> {
  if (!env.CLOUD_MODE) return null;
  return (await planFor(organizationId, workspaceId)).limits.maxProjects;
}

/* ─── Application service allowance ─────────────────────────────────────── */

/**
 * Refuse a new running service past the tier's allowance.
 *
 * Compose services share one VM, so workspace count cannot enforce this limit.
 * Count enabled definitions in activated projects, disabled definitions with a
 * live container, and single-app deployments (including queued reservations).
 * Callers hold the organization quota lock through the reservation write.
 */
export async function assertRunningServiceQuota(
  organizationId: string,
  addingCount = 1,
  replacingServiceIds: readonly string[] = [],
  workspaceId?: CloudWorkspaceScope,
): Promise<void> {
  if (!env.CLOUD_MODE) return;

  const { tier, limits } = await planFor(organizationId, workspaceId);
  const limit = limits.runningServices;
  if (limit === null) return;

  const used = await repos.service.countRunningForOrg(organizationId, replacingServiceIds, undefined, undefined, workspaceId);
  if (used + addingCount <= limit) return;

  throw new PlanUpgradeRequiredError(
    limit === 0
      ? "Choose a Cloud plan to run apps, databases and workers."
      : `Your plan includes ${limit} service slots and ${used} are reserved. Stop and disable a service, remove it, or upgrade to run more.`,
    "running-services",
    tier,
  );
}

/** Draft edits do not start services or reserve slots. Re-read the project
 * inside the caller's organization quota lock so creation/enabling cannot use
 * stale lifecycle state after waiting for another mutation. Deployment admission
 * reserves a draft's frozen service names before any provisioning starts. */
export async function assertServiceDefinitionQuota(
  organizationId: string,
  projectId: string,
  addingCount = 1,
  replacingServiceIds: readonly string[] = [],
): Promise<void> {
  if (!env.CLOUD_MODE || addingCount === 0) return;
  const project = await repos.project.findByIdInOrganization(projectId, organizationId);
  if (!project) throw new AppError("Project not found", 404, "PROJECT_NOT_FOUND");
  if (!project.activeDeploymentId) return;
  await assertRunningServiceQuota(organizationId, addingCount, replacingServiceIds, project.workspaceId ?? null);
}

/* ─── Build minutes ──────────────────────────────────────────────────────── */

/**
 * The window a monthly build-minute allowance is measured over.
 *
 * Anchored on the org's creation day, advancing by whole months — so an org
 * created on the 14th gets 15 minutes on the 14th of every month. Two rejected
 * alternatives, both real:
 *
 *   - `billing_subscription.current_period_*`: a FREE org has no subscription
 *     row, and nothing ever initializes `organization.current_period_start/end`
 *     (the anniversary cron's `lt(currentPeriodEnd, now)` never matches NULL).
 *   - a rolling `now() - 30 days`: what `getBillingState` uses for display. It
 *     slides forward on every read, so the same minutes leave the window at
 *     different times depending on when you ask, and the number can never be
 *     reconciled with an invoice. Fine for a dashboard figure, unusable as a
 *     boundary you refuse someone on.
 *
 * Pure and derived from a column that already exists — no migration, and a free
 * org needs no billing-period bookkeeping to be enforceable. Day-of-month
 * overflow clamps (created the 31st → the 28th/30th in shorter months).
 */
export function buildMinutePeriod(orgCreatedAt: Date, now: Date = new Date()): { from: Date; to: Date } {
  const anchorDay = orgCreatedAt.getUTCDate();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();

  const anniversary = (month: number) => new Date(Date.UTC(y, month,
    Math.min(anchorDay, new Date(Date.UTC(y, month + 1, 0)).getUTCDate())));
  let month = m;
  let from = anniversary(month);
  // Before this month's anniversary → we're still inside the period that opened
  // last month.
  if (from.getTime() > now.getTime()) from = anniversary(--month);
  const to = anniversary(month + 1);

  // An org created after "now" (clock skew, seeded fixtures) would invert the
  // window and match nothing; fall back to the calendar month.
  if (to.getTime() <= from.getTime()) {
    return { from: new Date(Date.UTC(y, m, 1)), to: new Date(Date.UTC(y, m + 1, 1)) };
  }
  return { from, to };
}

export interface BuildMinuteUsage {
  planTierId: PlanTierId;
  /** null = unlimited. */
  limitMinutes: number | null;
  usedMinutes: number;
  remainingMinutes: number | null;
  exhausted: boolean;
  periodStart: Date;
  periodEnd: Date;
}

/**
 * Where an org stands against its build-minute allowance.
 *
 * A failed usage read is unknown. Never turn a database outage into a fresh
 * allowance; callers can retry without starting more metered work.
 */
export async function getBuildMinuteUsage(
  organizationId: string,
  snapshot?: { tier: PlanTierId; limits: PlanLimits },
  workspaceId?: CloudWorkspaceScope,
): Promise<BuildMinuteUsage> {
  const org = await repos.organization.findById(organizationId);
  const { tier, limits } = snapshot ?? (await planFor(organizationId, workspaceId));
  const limitMinutes = limits.buildMinutesPerMonth;
  const owner = workspaceId ? await requireCloudWorkspace(organizationId, workspaceId) : org;
  const { from, to } = buildMinutePeriod(owner?.createdAt ?? new Date(), new Date());

  const millis = await repos.deployment
    .sumBuildMillisForOrg(organizationId, from, to, workspaceId);
  const usedMinutes = Math.floor(millis / 60_000);

  return {
    planTierId: tier,
    limitMinutes,
    usedMinutes,
    remainingMinutes: limitMinutes === null ? null : Math.max(0, limitMinutes - usedMinutes),
    exhausted: limitMinutes !== null && usedMinutes >= limitMinutes,
    periodStart: from,
    periodEnd: to,
  };
}

/**
 * Refuse a build when the org has spent its monthly build minutes.
 *
 * Checked BEFORE the deployment row exists, so an out-of-allowance user gets a
 * clean 402 instead of a `failed` deployment they have to clean up. Cloud static
 * builds also consume resources and require a paid build allowance.
 */
export async function assertBuildMinutesAvailable(organizationId: string, workspaceId?: CloudWorkspaceScope): Promise<void> {
  if (!env.CLOUD_MODE) return;

  const usage = await getBuildMinuteUsage(organizationId, undefined, workspaceId);
  if (!usage.exhausted) return;

  throw new PlanUpgradeRequiredError(
    usage.limitMinutes === 0 ? "Choose a Cloud plan to build and deploy projects."
      : `You've used all ${usage.limitMinutes} build minutes included this month. They reset on ${usage.periodEnd.toISOString().slice(0, 10)} — upgrade for more.`,
    "build-minutes-exhausted",
    usage.planTierId,
  );
}

/* ─── Free subdomains ────────────────────────────────────────────────────── */

export interface FreeSubdomainUsage {
  planTierId: PlanTierId;
  /** null = unlimited. */
  limit: number | null;
  used: number;
  remaining: number | null;
}

/**
 * How many Cloud-managed (`*.opsh.io`) hostnames the org holds.
 *
 * Counted from OUR database via `isCloudManagedHostname` — the same predicate
 * `storedPublicEndpointsNeedCloud` gates on — and deduplicated, because the cost
 * is per distinct hostname on the edge.
 *
 * On the authority question: for a self-hosted box the truly authoritative count
 * is the org's Oblien namespace proxy list (the SaaS keeps no ledger of routes a
 * self-hosted instance created). This count is the local, fast, friendly one. It
 * is not tamper-proof — an operator owns their database — and that is an accepted
 * limitation of a *friendly* cap: the ceiling that actually binds is Oblien's
 * per-namespace slug ownership.
 */
/** One free subdomain the org holds, and what is holding it. */
export interface FreeSubdomainSlot {
  domainId: string;
  hostname: string;
  projectId: string | null;
  projectName: string;
  projectSlug: string;
  /** Set when a specific service owns the route rather than the project itself. */
  serviceId: string | null;
  createdAt: Date;
}

/**
 * ITEMIZE the org's free subdomains — which hostnames, in which projects.
 *
 * `getFreeSubdomainUsage` can only say "10 of 10", and a count is not something a
 * user can act on: a subdomain minted by a CLI deploy months ago, in a project
 * they no longer think about, is otherwise undiscoverable (there is no org-wide
 * domains page and `GET /api/domains` demands a projectId). This is what lets the
 * dashboard, the CLI and the over-quota error itself name the slots so a user can
 * release one.
 *
 * Filtered with the SAME predicate the cap counts on, so the list and the number
 * always agree.
 */
export async function listFreeSubdomains(organizationId: string, workspaceId?: CloudWorkspaceScope): Promise<FreeSubdomainSlot[]> {
  const rows = await repos.domain.listForOrgWithProject(organizationId, workspaceId);
  return rows
    .filter((r) => isCloudManagedHostname(r.hostname))
    .map((r) => ({
      domainId: r.id,
      hostname: r.hostname,
      projectId: r.projectId,
      projectName: r.projectName,
      projectSlug: r.projectSlug,
      serviceId: r.serviceId,
      createdAt: r.createdAt,
    }));
}

export async function getFreeSubdomainUsage(
  organizationId: string,
  snapshot?: { tier: PlanTierId; limits: PlanLimits },
  workspaceId?: CloudWorkspaceScope,
): Promise<FreeSubdomainUsage> {
  const { tier, limits } = snapshot ?? (await planFor(organizationId, workspaceId));
  const limit = limits.freeSubdomains;

  const hostnames = await repos.domain.listHostnamesForOrg(organizationId, workspaceId);
  const used = new Set(
    hostnames.filter((h) => isCloudManagedHostname(h)).map((h) => h.trim().toLowerCase()),
  ).size;

  return { planTierId: tier, limit, used, remaining: limit === null ? null : Math.max(0, limit - used) };
}

/**
 * Refuse a write that would take the org past its free-subdomain allowance.
 *
 * `candidateHostnames` must be the NET-NEW hostnames only. Two of the callers
 * already filter against the project's prior hosts before calling, and that
 * filtering is load-bearing: re-validating a project's whole endpoint set made a
 * project that already had a free sibling impossible to edit at all.
 *
 * Counted as a set union rather than `used + candidates.length` so re-submitting
 * a hostname the org already holds is free — an edit that introduces nothing new
 * must never be refused.
 */
export async function assertFreeSubdomainQuota(
  organizationId: string,
  candidateHostnames: readonly (string | null | undefined)[],
  workspaceId?: CloudWorkspaceScope,
): Promise<void> {
  if (!env.CLOUD_MODE) return;

  const candidates = candidateHostnames
    .filter((h): h is string => !!h && isCloudManagedHostname(h))
    .map((h) => h.trim().toLowerCase());
  if (candidates.length === 0) return;

  const { tier, limits } = await planFor(organizationId, workspaceId);
  const limit = limits.freeSubdomains;
  if (limit === null) return;

  // Itemized, not just counted: the refusal has to tell the user WHERE their
  // slots went, or a subdomain from a forgotten CLI deploy is an unsolvable
  // riddle. Same predicate as the count, so they can't disagree.
  const held = await listFreeSubdomains(organizationId, workspaceId);
  const existing = new Set(held.map((s) => s.hostname.trim().toLowerCase()));
  const before = existing.size;
  for (const c of candidates) existing.add(c);
  if (existing.size <= limit) return;

  throw new FreeSubdomainLimitError(
    `Your plan includes ${limit} free ${FREE_DOMAIN_SUFFIX} subdomains and you're already using ${before}. Release one below, upgrade for more, or point a custom domain you own at this project instead.`,
    tier,
    held,
  );
}
