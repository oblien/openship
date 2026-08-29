/**
 * Project resources service - CPU/memory/disk config + sleep mode.
 *
 * The ceiling for a limit is the TARGET MACHINE's real capacity (probed via
 * host-capacity.ts), not a hardcoded constant — a 64 GB box must be able to
 * hand a container 64 GB. And `0` means NO LIMIT, which is the self-hosted
 * default: the operator owns the hardware, so the machine is the cap. Cloud
 * still requires a concrete size (a metered workspace can't be unsized).
 */

import { repos } from "@repo/db";
import { ValidationError } from "@repo/core";
import type { ResourceConfig } from "@repo/adapters";
import {
  UNKNOWN_CAPACITY,
  resolveTierResources,
  type HostCapacity,
  type ResourceTier,
} from "@repo/core";
import { encodeResources, decodeResources } from "../../lib/resources";
import { assertResourceInOrg } from "../../lib/controller-helpers";
import { getHostCapacity } from "../../lib/host-capacity";
import { resolveSnapshotTarget } from "../deployments/build.service";
import type { TUpdateResourcesBody } from "./project.schema";

// ─── Target + capacity ───────────────────────────────────────────────────────

type ProjectRow = NonNullable<Awaited<ReturnType<typeof repos.project.findById>>>;

/**
 * Where this project deploys, and what that machine has.
 *
 * Capacity probing is best-effort: an unreachable box yields UNKNOWN_CAPACITY,
 * which enforces no ceiling rather than blocking the operator from saving.
 */
async function resolveTargetCapacity(
  project: ProjectRow,
): Promise<{ isCloud: boolean; capacity: HostCapacity }> {
  const target = await resolveSnapshotTarget(project).catch(() => ({
    deployTarget: undefined,
    serverId: undefined,
  }));
  const isCloud = target.deployTarget === "cloud" || !!project.cloudWorkspaceId;

  // Cloud sizes an Oblien workspace from the tier table, not from host hardware,
  // so there is nothing to probe (and no SSH target to probe it on).
  if (isCloud) return { isCloud: true, capacity: { ...UNKNOWN_CAPACITY } };

  const capacity = await getHostCapacity(target.serverId, project.organizationId).catch(
    () => ({ ...UNKNOWN_CAPACITY }),
  );
  return { isCloud: false, capacity };
}

// ─── Get resources ───────────────────────────────────────────────────────────

export async function getResources(projectId: string, organizationId: string) {
  const p = await repos.project.findById(projectId);
  assertResourceInOrg(p, "Project", organizationId, projectId);

  const production = p.resources as ResourceConfig | null;
  const build = p.buildResources as ResourceConfig | null;
  const { isCloud, capacity } = await resolveTargetCapacity(p);
  return encodeResources(production, build, p.sleepMode ?? "auto_sleep", p.port ?? 3000, {
    isCloud,
    capacity,
  });
}

// ─── Update resources ────────────────────────────────────────────────────────

/** A tier selection resolves to concrete numbers; explicit cpu/memory/disk on the
 *  same object win (that's what "custom" is). Absent both → nothing to write. */
function resolveIncoming(
  input: { tier?: ResourceTier; cpuCores?: number; memoryMb?: number; diskMb?: number },
): { cpuCores?: number; memoryMb?: number; diskMb?: number } | null {
  const hasExplicit =
    input.cpuCores !== undefined || input.memoryMb !== undefined || input.diskMb !== undefined;
  if (input.tier && input.tier !== "custom") {
    // A fixed tier ignores any stray values — the preset IS the selection.
    return resolveTierResources(input.tier);
  }
  if (input.tier === "custom" || hasExplicit) {
    if (!hasExplicit) {
      // "custom" with nothing typed = opt out of the presets entirely.
      return resolveTierResources("unlimited");
    }
    return { cpuCores: input.cpuCores, memoryMb: input.memoryMb, diskMb: input.diskMb };
  }
  return null;
}

export async function updateResources(
  projectId: string,
  data: TUpdateResourcesBody,
  organizationId: string,
) {
  const p = await repos.project.findById(projectId);
  assertResourceInOrg(p, "Project", organizationId, projectId);

  const update: Record<string, unknown> = {};
  const { isCloud, capacity } = await resolveTargetCapacity(p);
  // Cloud must be sized; self-hosted may legitimately be unlimited.
  const decodeOpts = { capacity, requireLimit: isCloud };

  try {
    const production = data.production ? resolveIncoming(data.production) : null;
    if (production) {
      update.resources = decodeResources(production, decodeOpts);
    }
    const build = data.build ? resolveIncoming(data.build) : null;
    if (build) {
      update.buildResources = decodeResources(build, decodeOpts);
    }
  } catch (err) {
    // decodeResources throws plain Errors for out-of-range/over-capacity input;
    // surface them as 400s rather than 500s.
    throw new ValidationError(err instanceof Error ? err.message : "Invalid resource values");
  }

  if (data.sleepMode) {
    update.sleepMode = data.sleepMode;
  }
  if (data.port) {
    update.port = data.port;
  }

  if (Object.keys(update).length > 0) {
    await repos.project.update(projectId, update);
  }
  return getResources(projectId, organizationId);
}

// ─── Sleep mode ──────────────────────────────────────────────────────────────

export async function setSleepMode(
  projectId: string,
  sleepMode: string,
  organizationId: string,
) {
  const p = await repos.project.findById(projectId);
  assertResourceInOrg(p, "Project", organizationId, projectId);

  if (!["auto_sleep", "always_on"].includes(sleepMode)) {
    throw new ValidationError("Invalid sleep mode. Must be 'auto_sleep' or 'always_on'");
  }

  await repos.project.update(projectId, { sleepMode });
  return { success: true, sleepMode };
}
