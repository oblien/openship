import { createHash } from "node:crypto";
import type {
  SecurityAdvisory,
  SecurityImageEvidence,
  SecurityRuntime,
  SecurityRuntimeEvidence,
} from "@repo/core";
import { repos, withAdvisoryLock } from "@repo/db";
import { reportCaughtError } from "@repo/core/diagnostics";
import type { ExecutionContext } from "../../../context";
import { assertResourceInOrg } from "../../lib/resource-access";
import { findActiveDeployment } from "../../lib/active-deployment";
import { disposeRuntime, resolveDeploymentRuntimeForRead } from "../../lib/deployment-runtime";
import { liveContainerIdWithRuntime, livePrimaryContainerId } from "../services/service-container";
import { mapWithLimit } from "../../lib/map-with-limit";
import { getProjectRuntimeImages } from "./runtime-image-check";
import { parseRuntimeProbe, runtimeVersionProbe } from "./runtime-probes";
import { assertSecurityChecksEnabled } from "./security-check-policy";
import { nextSecurityInspection, securityObservationDue } from "./security-freshness";

export interface SecurityInventory {
  deploymentId: string | null;
  images: SecurityImageEvidence[];
  runtimes: SecurityRuntimeEvidence[];
  unknownServices: (string | null)[];
  checkedAt: string | null;
  /** Rules that requested this observation, independent of feed/signature renewal. */
  probeKey?: string;
}

const pending = new Map<string, Promise<SecurityInventory>>();

function runtimeRules(advisories: readonly SecurityAdvisory[]) {
  return advisories.flatMap((advisory) =>
    advisory.targets
      .filter((target) => target.kind === "runtime")
      .map((target) => ({ id: advisory.id, revision: advisory.revision, ...target })),
  );
}

export function securityProbeKey(advisories: readonly SecurityAdvisory[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        runtimeRules(advisories)
          .map((rule) => JSON.stringify(rule))
          .sort(),
      ),
    )
    .digest("hex");
}

export async function projectSecurityInventory(
  ctx: ExecutionContext,
  projectId: string,
  advisories: readonly SecurityAdvisory[],
  refresh = false,
): Promise<SecurityInventory> {
  const project = await repos.project.findById(projectId);
  assertResourceInOrg(project, "Project", ctx.organizationId, projectId);
  // Shared admission point for status checks and advisory refreshes.
  await assertSecurityChecksEnabled(ctx.organizationId);
  const active = await findActiveDeployment(project);
  const empty: SecurityInventory = {
    deploymentId: null,
    images: [],
    runtimes: [],
    unknownServices: [null],
    checkedAt: null,
  };
  if (!active || project.deletionInProgress) return empty;
  const probeKey = securityProbeKey(advisories);
  const key = `${ctx.organizationId}:${projectId}:${active.id}:${probeKey}`;
  const stored = await repos.securityAdvisory.project(projectId);
  const running = pending.get(key);
  if (running) return running;
  const cached = stored?.inventory as SecurityInventory | null;
  if (
    !refresh &&
    !securityObservationDue(stored) &&
    stored?.deploymentId === active.id &&
    cached?.probeKey === probeKey
  )
    return cached;
  const runtimes = [...new Set(runtimeRules(advisories).map((rule) => rule.runtime))];
  const requestedAt = Date.now();
  const task = withAdvisoryLock(`security:inventory:${projectId}`, async () => {
    await assertSecurityChecksEnabled(ctx.organizationId);
    // Another worker may have inspected while this request waited for the lock.
    const latest = await repos.securityAdvisory.project(projectId);
    const evidence = latest?.inventory as SecurityInventory | null;
    if (
      latest?.deploymentId === active.id &&
      evidence?.probeKey === probeKey &&
      !securityObservationDue(latest) &&
      (!refresh || (latest.checkedAt?.getTime() ?? 0) >= requestedAt)
    )
      return evidence;
    return readSecurityInventory(ctx, projectId, active.id, probeKey, runtimes);
  });
  pending.set(key, task);
  try {
    return await task;
  } finally {
    pending.delete(key);
  }
}

/** Bounded observations on expiry, changed rules/deployment or explicit checks. */
async function readSecurityInventory(
  ctx: ExecutionContext,
  projectId: string,
  deploymentId: string,
  probeKey: string,
  runtimes: SecurityRuntime[],
): Promise<SecurityInventory> {
  const project = await repos.project.findById(projectId);
  assertResourceInOrg(project, "Project", ctx.organizationId, projectId);
  const active = await findActiveDeployment(project);
  const empty: SecurityInventory = {
    deploymentId: null,
    images: [],
    runtimes: [],
    unknownServices: [null],
    checkedAt: null,
  };
  if (!active || active.id !== deploymentId || project.deletionInProgress) return empty;
  const checkedAt = new Date(Date.now());
  const imageRows = await getProjectRuntimeImages(ctx, projectId);
  const inventory: SecurityInventory = {
    deploymentId: active.id,
    checkedAt: checkedAt.toISOString(),
    images: imageRows.images.map((image) => ({
      serviceId: image.serviceId,
      serviceName: image.serviceName,
      role: image.role,
      ref: image.ref,
      digest: image.currentDigest,
    })),
    runtimes: [],
    unknownServices: [],
    probeKey,
  };
  const services = (await repos.service.listByProject(projectId)).filter(
    (service) => service.enabled,
  );
  const rows = await repos.service.listByDeployment(active.id);
  const scopes = services.length
    ? services.map((service) => ({ id: service.id as string | null, name: service.name }))
    : [{ id: null, name: project.name }];
  // Image notices use existing deployment receipts. No runtime advisory means no exec.
  const resolved = runtimes.length
    ? await resolveDeploymentRuntimeForRead(active).catch((error) => {
        reportCaughtError(error, "platform/updates/security-inventory.resolve-runtime");
        return null;
      })
    : null;
  try {
    const runtime = resolved?.runtime;
    if (!runtimes.length) {
      // The feed has no runtime checks to perform.
    } else if (!runtime?.supports("isolatedExec") || !runtime.inContainerExecutor) {
      inventory.unknownServices = scopes.map((scope) => scope.id);
    } else {
      const deadline = Date.now() + 30_000;
      await mapWithLimit(scopes, 2, async (scope) => {
        try {
          if (Date.now() >= deadline) {
            inventory.unknownServices.push(scope.id);
            return;
          }
          const container = scope.id
            ? await liveContainerIdWithRuntime(runtime, {
                service: { id: scope.id, name: scope.name },
                projectId,
                slug: project.slug,
                tracked: rows.find((row) => row.serviceId === scope.id)?.containerId ?? null,
              })
            : await livePrimaryContainerId(runtime, active);
          if (!container) {
            inventory.unknownServices.push(scope.id);
            return;
          }
          const executor = await runtime.inContainerExecutor!(container);
          const output = await executor.exec(runtimeVersionProbe(runtimes), { timeout: 10_000 });
          const observations = parseRuntimeProbe(output.slice(0, 16_384), scope.id);
          inventory.runtimes.push(...observations);
          if (!observations.length) inventory.unknownServices.push(scope.id);
        } catch (error) {
          reportCaughtError(error, "platform/updates/security-inventory.inspect");
          inventory.unknownServices.push(scope.id);
        }
      });
    }
  } finally {
    disposeRuntime(resolved?.runtime);
  }
  // Never bind evidence from a replaced container to the new release.
  const current = await repos.project.findById(projectId);
  assertResourceInOrg(current, "Project", ctx.organizationId, projectId);
  if (current.activeDeploymentId !== active.id || current.deletionInProgress) return empty;
  const previous = await repos.securityAdvisory.project(projectId);
  const prior = previous?.inventory as SecurityInventory | null;
  if (previous?.deploymentId === active.id && prior?.probeKey === probeKey) {
    // One working runtime does not prove another runtime's failed/missing probe
    // was fixed. Retain only missing runtime identities, never old versions of
    // a runtime that was successfully observed again.
    const identity = (row: SecurityRuntimeEvidence) => JSON.stringify([row.serviceId, row.runtime]);
    const observed = new Set(inventory.runtimes.map(identity));
    const retained = prior.runtimes.filter((row) => !observed.has(identity(row)));
    inventory.runtimes.push(...retained);
    if (retained.length) {
      inventory.checkedAt = prior.checkedAt;
      inventory.unknownServices = [
        ...new Set([...inventory.unknownServices, ...retained.map((row) => row.serviceId)]),
      ];
    }
  }
  const failures = inventory.unknownServices.length
    ? Math.min((previous?.probeFailures ?? 0) + 1, 16)
    : 0;
  await repos.securityAdvisory.saveInventory(
    projectId,
    ctx.organizationId,
    active.id,
    inventory,
    checkedAt,
    nextSecurityInspection(projectId, checkedAt, failures),
    failures,
  );
  return inventory;
}
