import { repos } from "@repo/db";
import { safeErrorMessage } from "@repo/core";

import { syncProjectManagedEdge } from "../projects/project-runtime.service";

/**
 * What else has to follow a project when its workload moves to another server.
 *
 * Moving the containers and their data is the visible half. The other half is everything that
 * RECORDED where the project used to live and now points at a box it no longer runs on. Those
 * were not handled at all: a migrated project kept its free `.opsh.io` subdomain aimed at the
 * source server, so the URL resolved to the old machine until an operator noticed and pressed
 * "Retry routing" by hand.
 *
 * A LIST, not a few more inline awaits, because this set only grows — linked apps, webhooks, DNS
 * records, backup destinations, anything that stores a server id or an address. Each new one is an
 * entry here, next to the others, run and logged the same way. Inline, the fourth would be written
 * by whoever hit the fourth bug and the first three would not be findable from it.
 *
 * EVERY effect is best-effort by design. At the point these run the workload is already up and
 * verified on the target; failing the migration because a follow-up didn't land would tear down a
 * working stack over a record that can be repaired from the UI. So each one logs what it did or
 * why it didn't, and the run continues.
 */
export interface RelocationEffect {
  /** Short, stable label for the session log. */
  name: string;
  /**
   * Do the work. Return a detail string to log beside the name; return nothing when there was
   * simply nothing to do (logged as "nothing to update" rather than silence, so an operator can
   * tell "checked and clear" from "never ran").
   */
  run: () => Promise<string | void>;
}

/**
 * The effects for a project that has just started serving from `targetServerId`.
 *
 * Ordered, and the order is part of the contract: these run AFTER the project's routes have been
 * published on the target, because several of them re-point things that only exist once the routes
 * do.
 */
export function projectRelocationEffects(input: {
  projectId: string;
  organizationId: string;
  targetServerId: string;
}): RelocationEffect[] {
  return [
    {
      // Free `*.opsh.io` subdomains are a mapping from a hostname to a SERVER, held by the
      // cloud edge. `syncProjectManagedEdge` re-registers them, and it reads the server from
      // the project's ACTIVE deployment — which is exactly why it has to run here and not
      // during the deploy: at that point the target deployment was not active yet, so the
      // sync inside the deploy re-pointed the subdomain at the server the project was leaving.
      name: "free subdomain routing",
      run: async () => {
        const project = await repos.project.findById(input.projectId);
        if (!project) return;
        const { ok, failures } = await syncProjectManagedEdge(project, input.organizationId);
        if (ok) return "re-pointed at the new server";
        // Reported, not thrown: the project is serving. The dashboard's own "Retry routing"
        // repairs this, and the warning it keys off is set by the sync itself.
        return `still pointing at the old server — ${failures.join("; ") || "sync failed"}`;
      },
    },
  ];
}

/** Run each effect in order, logging one line per effect. Never throws. */
export async function applyRelocationEffects(
  effects: RelocationEffect[],
  log: (message: string) => void,
): Promise<void> {
  for (const effect of effects) {
    try {
      const detail = await effect.run();
      log(`${effect.name}: ${detail || "nothing to update"}`);
    } catch (err) {
      log(`${effect.name}: not updated — ${safeErrorMessage(err)}`);
    }
  }
}
