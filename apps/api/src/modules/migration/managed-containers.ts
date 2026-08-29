/**
 * "Does this instance already manage these containers?" — asked once, answered for
 * every caller that needs it.
 *
 * Two callers need the same lookup and must reach DIFFERENT conclusions:
 *   - the MIGRATION refuses a re-import (it would mint a duplicate project over live
 *     containers: `-2` services, routes bound to the wrong port, phantom domains);
 *   - the PREVIEW must not refuse anything. It is a read-only plan, and a 502 where a
 *     plan should be is how the operator learns nothing.
 *
 * So the LOOKUP is shared and the POLICY is not. `classifyManagedContainers` does the
 * database work and makes no decisions; `excludeAlreadyManaged` is the migration's
 * policy over it. Two copies of the classification is how those two would drift into
 * disagreeing about what is safe — and the disagreement would surface as a plan the
 * user approved for a migration that then refuses, or worse, the reverse.
 *
 * THE CONTROL PLANE IS NOT A RE-IMPORT. `linkSelfAppServices` binds Openship's own
 * compose containers (`api`, `dashboard`, `edge`, `postgres`, `redis`) to the
 * control-plane project. Those names collide with ordinary stacks, so a name-based
 * selection matched them and the gate refused the operator's entire migration,
 * unretryably (#584). Adopting Openship into a user project is forbidden outright
 * (`assertNotControlPlane`), so there is no decision to put to the operator: drop ours
 * and migrate the rest. This stays as the backstop for a name-only client, which
 * cannot tell the user's `postgres` from ours; the scan's structural exclusion
 * (`controlPlaneContainerIds`) is what keeps them out of the candidate pool at all.
 */

import { repos } from "@repo/db";

import { isControlPlaneProject } from "../../lib/controller-helpers";
import type { DiscoveredService } from "./docker-reconcile";

/** A container this instance already manages for a real (non-control-plane) project. */
export interface ManagedConflict {
  /** The discovered service that collided, when the caller supplied it. */
  serviceName?: string;
  containerId: string;
  projectId: string;
  projectName: string;
}

export interface ManagedClassification {
  /** Container ids belonging to Openship ITSELF — never adoptable, never a conflict. */
  controlPlane: Set<string>;
  /** Container ids a real project already manages: a genuine re-import. */
  conflicts: ManagedConflict[];
}

/**
 * Which of `chosen` this instance already manages, split by what the caller should do
 * about it. Makes no decisions and never throws — a failed lookup yields an empty
 * classification, leaving each caller's own behaviour unchanged rather than turning an
 * unrelated deploy into a 500.
 *
 * Rows that must never block anything are dropped here, once, for both policies:
 * another organization's row, a soft-deleted project (deleting the project IS the
 * documented way to clear a stale block), and a row whose deployment is gone.
 */
export async function classifyManagedContainers(
  chosen: DiscoveredService[],
  organizationId: string,
): Promise<ManagedClassification> {
  const empty: ManagedClassification = { controlPlane: new Set(), conflicts: [] };
  const ids = chosen
    .map((s) => s.containerId)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  if (ids.length === 0) return empty;

  try {
    const managed = await repos.service.findByContainerIds(ids);
    const byContainer = new Map(
      chosen.filter((s) => s.containerId).map((s) => [s.containerId!, s]),
    );
    const out: ManagedClassification = { controlPlane: new Set(), conflicts: [] };

    for (const sd of managed) {
      if (!sd.containerId) continue;
      const dep = await repos.deployment.findById(sd.deploymentId).catch(() => null);
      if (!dep || dep.organizationId !== organizationId) continue; // other org / stale row
      const proj = await repos.project.findById(dep.projectId).catch(() => null);
      if (!proj || proj.deletedAt) continue;
      if (isControlPlaneProject(proj)) {
        out.controlPlane.add(sd.containerId);
        continue;
      }
      out.conflicts.push({
        serviceName: byContainer.get(sd.containerId)?.name,
        containerId: sd.containerId,
        projectId: proj.id,
        projectName: proj.name,
      });
    }
    return out;
  } catch {
    return empty;
  }
}

/**
 * The MIGRATION's policy: drop Openship's own containers, refuse a real re-import.
 *
 * Applied by both the adopt path and the orchestrator, which re-discover the server
 * independently — the orchestrator's set is the one that decides
 * `scannedContainerIds`, and moveData's first act is `rtA.stop(cid)` on every id in
 * it. Skipping it there would stop Openship's own database to copy its volume.
 */
// NO opt-out parameter. This briefly took a `duplicatingToAnotherHost` flag, because duplicating
// a project ran its own containers through this gate and needed the refusal suppressed. A
// duplicate now COPIES the project's records instead of re-adopting its containers
// (`cloneProjectToServer`), so it never reaches here — and the gate is back to meaning one
// thing: containers this instance already manages are never adopted again, full stop. A gate
// with a caller-supplied exemption is a gate you have to read every caller to trust.
export async function excludeAlreadyManaged(
  chosen: DiscoveredService[],
  organizationId: string,
): Promise<DiscoveredService[]> {
  const { controlPlane, conflicts } = await classifyManagedContainers(chosen, organizationId);

  const first = conflicts[0];
  if (first) {
    // Name the OFFENDER and the way out. "These containers are already managed" told
    // the operator neither WHICH of six services collided nor what to do about it —
    // which is why #584 read as "Openship thinks everything is already managed".
    const which = first.serviceName
      ? `Service "${first.serviceName}" (container ${first.containerId.slice(0, 12)}) is`
      : "These containers are";
    throw new Error(
      `${which} already managed here by project "${first.projectName}". ` +
        `Redeploy or edit that project instead of re-importing — a re-import would ` +
        `duplicate its services and routes. If that project is a leftover from a failed ` +
        `run, delete it and try again.`,
    );
  }

  if (controlPlane.size === 0) return chosen;
  const kept = chosen.filter((s) => !(s.containerId && controlPlane.has(s.containerId)));
  if (kept.length === 0) {
    throw new Error(
      "Only Openship's own containers matched the selected service names. " +
        "Openship manages its own runtime — pick the services you want to migrate instead.",
    );
  }
  return kept;
}
