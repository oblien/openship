import { createHash } from "node:crypto";
import type {
  SecurityAdvisory,
  SecurityImageEvidence,
  SecurityRuntime,
  SecurityRuntimeEvidence,
} from "@repo/core";
import { repos } from "@repo/db";
import { reportCaughtError } from "@repo/core/diagnostics";
import type { ExecutionContext } from "../../../context";
import { assertResourceInOrg } from "../../lib/resource-access";
import { findActiveDeployment } from "../../lib/active-deployment";
import { disposeRuntime, resolveDeploymentRuntimeForRead } from "../../lib/deployment-runtime";
import { liveContainerIdWithRuntime, livePrimaryContainerId } from "../services/service-container";
import { mapWithLimit } from "../../lib/map-with-limit";
import { getProjectRuntimeImages } from "./runtime-image-check";
import { parseRuntimeProbe, runtimeVersionProbe } from "./runtime-probes";

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
  if (!refresh && stored?.deploymentId === active.id && cached?.probeKey === probeKey)
    return cached;
  const runtimes = [...new Set(runtimeRules(advisories).map((rule) => rule.runtime))];
  const task = readSecurityInventory(ctx, projectId, active.id, probeKey, runtimes);
  pending.set(key, task);
  try {
    return await task;
  } finally {
    pending.delete(key);
  }
}

/** Event-driven observation: changed rules/deployment or an explicit check. No host fallback. */
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
  const checkedAt = new Date();
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
  await repos.securityAdvisory.saveInventory(
    projectId,
    ctx.organizationId,
    active.id,
    inventory,
    checkedAt,
  );
  return inventory;
}
