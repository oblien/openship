import type Dockerode from "dockerode";
import type { MultiServiceDeployConfig, MultiServiceGroupHandle } from "./types";
import { stableName } from "./cutover";

/** Primitives composed into the existing deploy pipeline; no routing or DB writes. */
export interface DockerServiceCutover {
  config: MultiServiceDeployConfig;
  previousContainerId: string;
  /** Container-label provenance; the engine verifies its saved routing ports. */
  readonly previousDeploymentId?: string;
  /** Publish service DNS only after the caller has verified readiness. */
  publish(containerId: string): Promise<{ ip?: string }>;
  /** Called only after the complete stack is healthy, routed and persisted. */
  retire(containerId: string): Promise<void>;
}

export function dockerServiceCutover(
  docker: Dockerode,
  group: MultiServiceGroupHandle,
  config: MultiServiceDeployConfig,
  previous: Dockerode.ContainerInspectInfo,
  aliases: string[],
  destroy: (containerId: string) => Promise<void>,
): DockerServiceCutover {
  const previousContainerId = previous.Id;
  const inspectCandidate = async (containerId: string) => {
    const candidate = docker.getContainer(containerId);
    const info = await candidate.inspect();
    const labels = info.Config?.Labels ?? {};
    if (
      labels["openship.project"] !== config.projectId ||
      labels["openship.service"] !== config.serviceName ||
      labels["openship.deployment"] !== config.deploymentId ||
      info.Id === previousContainerId
    )
      throw new Error("The staged container does not belong to this deployment.");
    return { candidate, info };
  };
  return {
    config,
    previousContainerId,
    previousDeploymentId: previous.Config?.Labels?.["openship.deployment"],
    async publish(containerId) {
      const { info } = await inspectCandidate(containerId);
      const endpoint = Object.entries(info.NetworkSettings?.Networks ?? {}).find(
        ([name, endpoint]) => name === group.id || endpoint.NetworkID === group.id,
      );
      if (!endpoint) throw new Error("The staged service has no project network endpoint.");
      const network = docker.getNetwork(group.id);
      // Only the candidate moves. A failed connect leaves the original's names,
      // networks and routes untouched. The returned IP is observed AFTER reconnect.
      await network.disconnect({ Container: containerId });
      await network.connect({ Container: containerId, EndpointConfig: { Aliases: aliases } });
      const after = await docker.getContainer(containerId).inspect();
      const published = Object.entries(after.NetworkSettings?.Networks ?? {}).find(
        ([name, endpoint]) => name === group.id || endpoint.NetworkID === group.id,
      )?.[1];
      if (!published?.IPAddress) throw new Error("The staged service has no routable project IP.");
      return { ip: published.IPAddress };
    },
    async retire(containerId) {
      const { candidate, info } = await inspectCandidate(containerId);
      if (
        !info.State.Running ||
        info.State.Paused ||
        info.State.Dead ||
        info.State.OOMKilled ||
        info.State.Restarting ||
        info.RestartCount > 0 ||
        info.State.Health?.Status === "unhealthy" ||
        info.State.Health?.Status === "starting"
      )
        throw new Error("The replacement is not healthy; the previous service was preserved.");
      const original = docker.getContainer(previousContainerId);
      const live = await original.inspect();
      if (
        live.Config?.Labels?.["openship.project"] !== config.projectId ||
        live.Config?.Labels?.["openship.service"] !== config.serviceName
      )
        throw new Error("The previous service's ownership changed; it was not removed.");
      const stable = stableName(config);
      // Preserve the familiar service name without touching it during activation.
      // Failure here is cleanup failure, not grounds to destroy the live candidate.
      if (live.Name.replace(/^\//, "") === stable) {
        const backup = `${stable}-previous-${previousContainerId.slice(0, 12)}`;
        await original.rename({ name: backup });
        try {
          await candidate.rename({ name: stable });
        } catch (error) {
          await original.rename({ name: stable });
          throw error;
        }
      }
      await destroy(previousContainerId);
    },
  };
}
