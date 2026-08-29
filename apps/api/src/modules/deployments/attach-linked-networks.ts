/**
 * Shared cross-project service-link networking — the ONE place that attaches a
 * consumer project's containers to the docker networks of the source apps it
 * connects to over INTERNAL mode.
 *
 * When project A "connects" a database/service app B in internal mode, B's
 * connection URL is rewritten to B's service alias (e.g. `mongo:27017`,
 * `db:5432`) — which only resolves if A's container is ON B's
 * `openship-<slug>` network. Both the compose/services deploy path AND the
 * single-app build/deploy path call this so BOTH consumer kinds actually reach
 * their linked services (single-app used to skip it → injected host unresolved).
 *
 * Advisory, mirroring "domains never fail a deploy": a link-networking failure
 * is logged, never thrown. Runtimes without `attachToExternalNetworks` (e.g.
 * cloud) no-op here — internal mode is gated off for cloud sources at connect.
 */
import { repos } from "@repo/db";

type AttachRuntime = {
  attachToExternalNetworks?: (
    projectId: string,
    networks: string[],
    extraContainerIds?: string[],
  ) => Promise<void>;
};

/** Docker network name for a project slug — the source app's private network. */
export function linkedNetworkName(slug: string): string {
  return `openship-${slug}`;
}

export async function attachLinkedNetworks(
  projectId: string,
  runtime: AttachRuntime,
  log?: (message: string, level?: "info" | "warn") => void,
): Promise<void> {
  if (!runtime.attachToExternalNetworks) return; // runtime can't join external nets (cloud)
  try {
    const links = await repos.projectConnection.listByTarget(projectId);
    const nets: string[] = [];
    for (const link of links) {
      if (link.mode !== "internal") continue;
      const src = await repos.project.findById(link.sourceProjectId);
      if (src?.slug) nets.push(linkedNetworkName(src.slug));
    }
    if (nets.length > 0) {
      /**
       * Name this project's containers EXPLICITLY as well as by label.
       *
       * `attachToExternalNetworks` filters on `openship.project=<id>`, and an ADOPTED
       * (in-place migrated) container keeps its ORIGINAL labels — labels are immutable, which
       * is why the migration has its own id-keyed joiner at all. So for a migrated consumer
       * the label match found nothing: the alias (`db:5432`) went into the env and the
       * container was never joined to the source app's network, so the connection failed to
       * resolve while the UI reported success. Stored container ids are the identity the READ
       * paths already use (services/live-state.ts).
       */
      const project = await repos.project.findById(projectId).catch(() => null);
      const stored = project?.activeDeploymentId
        ? (await repos.service.listByDeployment(project.activeDeploymentId).catch(() => []))
            .map((row) => row.containerId)
            .filter((id): id is string => !!id)
        : [];
      await runtime.attachToExternalNetworks(projectId, nets, stored);
      log?.(`Attached to ${nets.length} connected service network(s).`, "info");
    }
  } catch (err) {
    log?.(
      `Warning: could not attach linked service networks: ${err instanceof Error ? err.message : String(err)}`,
      "warn",
    );
  }
}
