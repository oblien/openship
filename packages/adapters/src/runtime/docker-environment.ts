import { providerFailureMessage, reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import type Dockerode from "dockerode";
import { AppError, isValidEnvKey } from "@repo/core";
import { randomUUID } from "node:crypto";
import { isRuntimeNotFoundError } from "../system/errors";
import { splitRuntimeEnv } from "./runtime-env";
import { stabilitySampleFromDockerInspect } from "./docker-container-info";
import { classifyStability } from "./stability";

const STARTUP_CHECK_MS = 1000;

export interface DockerEnvironmentResult {
  containerId: string;
  ip?: string;
  warning?: string;
}

export interface DockerEnvironmentOptions {
  projectId: string;
  serviceName: string;
  /** Re-resolved authored Compose command, when it depends on this environment. */
  commandArgv?: string[];
  /** Persist the new runtime identity before discarding the recoverable original. */
  onReplaced: (result: DockerEnvironmentResult) => Promise<void>;
  /** Restore routing if rollback gives the original a different dynamic IP. */
  onRestored?: (result: DockerEnvironmentResult) => Promise<void>;
}

function conflict(message: string): never {
  throw new AppError(message, 409, "SERVICE_ENVIRONMENT_UNAVAILABLE");
}

/** Its text is built from approved messages and public Docker state fields. */
class EnvironmentStartupError extends Error {}

function containerIdentity(
  containerId: string,
  info: Dockerode.ContainerInspectInfo,
): DockerEnvironmentResult {
  const ip = Object.values(info.NetworkSettings.Networks ?? {})
    .map((network) => network.IPAddress)
    .find(Boolean);
  return { containerId, ...(ip ? { ip } : {}) };
}

/** Replace a container's environment and its dependent authored Compose Cmd.
 * No build, image pull, or VM operation.
 * Keep the original stopped container until start AND bookkeeping succeed, so a
 * bad environment or a failed DB write can restore the original configuration. */
export async function applyDockerEnvironment(
  docker: Dockerode,
  containerId: string,
  environment: Record<string, string>,
  options: DockerEnvironmentOptions,
): Promise<DockerEnvironmentResult> {
  for (const [key, value] of Object.entries(environment)) {
    if (!isValidEnvKey(key) || value.includes("\0")) {
      throw new AppError(
        `Invalid runtime environment variable "${key}".`,
        400,
        "INVALID_ENVIRONMENT",
      );
    }
  }
  const original = docker.getContainer(containerId);
  // Never report the original provider error, its stack or attached payload.
  const reportFailure = (error: unknown, summary: string) => {
    const message = error instanceof EnvironmentStartupError
      ? error.message : providerFailureMessage(error, summary);
    observeCaughtError(new Error(message), "adapters/runtime/docker-environment");
    return message;
  };
  let before: Dockerode.ContainerInspectInfo;
  try {
    before = await original.inspect();
  } catch (error) {
    throw new AppError(reportFailure(error, "The running service could not be inspected"), 502, "SERVICE_ENVIRONMENT_UNAVAILABLE");
  }
  const labels = before.Config.Labels ?? {};
  if (
    (labels["openship.project"] && labels["openship.project"] !== options.projectId) ||
    (labels["openship.service"] && labels["openship.service"] !== options.serviceName)
  )
    conflict("The running container does not belong to this service.");
  if (before.State.Paused || before.HostConfig.AutoRemove) {
    conflict(
      "This container cannot apply environment changes in place. Unpause it or use Redeploy.",
    );
  }
  if (!before.Image) conflict("The running service's image could not be identified. Use Redeploy.");

  // The immutable image ID comes from the live container, never a mutable tag
  // or the previous deployment's possibly stale local build tag. A daemon/auth
  // failure must propagate; it is not evidence that we should try Docker Hub.
  try {
    await docker.getImage(before.Image).inspect();
  } catch (error) {
    if (isRuntimeNotFoundError(error)) {
      conflict(
        "The running service's image is no longer available on this target. Use Redeploy to rebuild it.",
      );
    }
    throw new AppError(reportFailure(error, "The service image could not be inspected"), 502, "SERVICE_ENVIRONMENT_UNAVAILABLE");
  }

  const name = before.Name.replace(/^\//, "");
  const networkMode = before.HostConfig.NetworkMode ?? "default";
  const sharedNetwork = networkMode.startsWith("container:");
  const networks = Object.entries(before.NetworkSettings.Networks ?? {});
  // Built-in bridge networks do not support the service's DNS aliases.
  if (networks.some(([network]) => network === "bridge")) {
    conflict(
      "This service uses Docker's default bridge. Use Redeploy to apply its environment and update routing.",
    );
  }
  const endpointSettings = Object.fromEntries(
    networks
      .filter(([network]) => network !== "host" && network !== "none")
      .map(([network, endpoint]) => {
        const driverOpts = (endpoint as typeof endpoint & { DriverOpts?: Record<string, string> })
          .DriverOpts;
        return [
          network,
          {
            // IPAMConfig contains the requested configuration; IPAddress and
            // GlobalIPv6Address are Docker's observations, not static assignments.
            // Replaying an observed address fails on automatic-subnet networks on
            // Docker 28 and earlier. Preserve real static assignments only.
            ...(endpoint.IPAMConfig ? { IPAMConfig: structuredClone(endpoint.IPAMConfig) } : {}),
            Aliases: (endpoint.Aliases ?? []).filter(
              (alias: string) => alias !== before.Id && alias !== before.Id.slice(0, 12),
            ),
            ...(endpoint.Links ? { Links: endpoint.Links } : {}),
            ...(driverOpts ? { DriverOpts: driverOpts } : {}),
          },
        ];
      }),
  );

  // Reuse image-declared anonymous volumes too. Replaying Config.Volumes alone
  // creates empty anonymous volumes, even when all explicit binds are retained.
  const hostConfig = structuredClone(before.HostConfig);
  const binds = [...(hostConfig.Binds ?? [])];
  const mounted = new Set([
    ...binds.map((bind) => bind.split(":")[1]),
    ...(hostConfig.Mounts ?? []).map((mount) => mount.Target),
  ]);
  for (const mount of before.Mounts ?? []) {
    if (mount.Type === "volume" && mount.Name && !mounted.has(mount.Destination)) {
      binds.push(`${mount.Name}:${mount.Destination}:${mount.RW ? "rw" : "ro"}`);
    }
  }
  hostConfig.Binds = binds;
  const { Hostname: hostname, ...config } = before.Config;
  const create: Dockerode.ContainerCreateOptions = {
    ...config,
    ...(sharedNetwork ? {} : { Hostname: hostname }),
    name: `${name}-env-next-${randomUUID().slice(0, 8)}`,
    Image: before.Image,
    Env: splitRuntimeEnv(environment).entries.map(([key, value]) => `${key}=${value}`),
    ...(options.commandArgv !== undefined ? { Cmd: options.commandArgv } : {}),
    HostConfig: hostConfig,
    ...(Object.keys(endpointSettings).length > 0
      ? { NetworkingConfig: { EndpointsConfig: endpointSettings } }
      : {}),
  };

  let replacement: Dockerode.Container | undefined;
  let renamed = false;
  let stopped = false;
  const disconnected: string[] = [];
  const wasRunning = before.State.Running || before.State.Restarting;
  let operation = "Creating the replacement container";
  try {
    // Docker validates the image, mounts and network configuration at create
    // time, without starting a second process over the service's volumes.
    replacement = await docker.createContainer(create);
    if (wasRunning) {
      // stop() honors the configured signal/grace period and Docker's default
      // SIGTERM/10s when none was specified. Never force-remove the live app.
      operation = "Stopping the previous container";
      await original.stop();
      stopped = true;
    }
    operation = "Reserving the previous container name";
    await original.rename({ name: `${name}-env-backup-${randomUUID().slice(0, 8)}` });
    renamed = true;
    for (const network of Object.keys(endpointSettings)) {
      // A static assignment must be released before the replacement starts.
      // Dynamic endpoints can stay attached to the stopped original, preserving
      // its network configuration for rollback without unnecessary reconnects.
      const ipam = endpointSettings[network]!.IPAMConfig;
      if (!ipam?.IPv4Address && !ipam?.IPv6Address) continue;
      operation = "Releasing the previous container's static network address";
      await docker.getNetwork(network).disconnect({ Container: before.Id });
      disconnected.push(network);
    }
    operation = "Naming the replacement container";
    await replacement.rename({ name });
    operation = "Starting the replacement container";
    await replacement.start();
    // Docker acknowledges start before PID 1 has read its environment. Catch an
    // immediate startup exit before discarding the recoverable old container.
    await new Promise((resolve) => setTimeout(resolve, STARTUP_CHECK_MS));
    operation = "Inspecting the replacement container";
    const after = await replacement.inspect();
    const sample = stabilitySampleFromDockerInspect(after);
    // The same classifier as deployment. This fresh replacement starts at zero
    // restarts; Apply retains its short check and rejects any startup bounce.
    // State.Error is free-form provider text and can contain credentials that
    // were never present in the service env. The verdict uses structured state.
    const latest = { ...sample, errorLine: null };
    const verdict = classifyStability({ ...latest, restartCount: 0 }, latest, {
      windowMs: STARTUP_CHECK_MS, pollMs: STARTUP_CHECK_MS, crashRestarts: 1, windowElapsed: true,
    });
    if (verdict?.status !== "stable") {
      throw new EnvironmentStartupError(
        `The service failed to start: ${verdict?.reason ?? "the container did not remain running"}. Check the service logs for details.`,
      );
    }
    const result = containerIdentity(replacement.id, after);
    operation = "Saving the replacement service and refreshing its routes";
    await options.onReplaced(result);

    // The replacement is serving and its identity is durable. Cleanup failure
    // must not roll back a committed apply or report that the env was not applied.
    try {
      await original.remove();
    } catch (diagnosticFailure) {
      reportFailure(diagnosticFailure, "The stopped previous container could not be removed");
      result.warning =
        "Environment applied, but the stopped previous container could not be removed.";
    }
    return result;
  } catch (error) {
    const failure = reportFailure(error, `${operation} failed`);
    const recovery: string[] = [];
    if (replacement) {
      try {
        await replacement.stop().catch((err) => {
          if ((err as { statusCode?: number }).statusCode !== 304 && !isRuntimeNotFoundError(err))
            throw err;
        });
        await replacement.remove();
      } catch (restoreError) {
        recovery.push(reportFailure(restoreError, "The failed replacement could not be removed"));
      }
    }
    if (renamed) {
      try {
        await original.rename({ name });
      } catch (restoreError) {
        recovery.push(reportFailure(restoreError, "The previous container name could not be restored"));
      }
    }
    for (const network of disconnected) {
      try {
        await docker
          .getNetwork(network)
          .connect({ Container: before.Id, EndpointConfig: endpointSettings[network] });
      } catch (restoreError) {
        recovery.push(reportFailure(restoreError, "The previous container network could not be restored"));
      }
    }
    if (stopped && recovery.length === 0) {
      try {
        await original.start();
      } catch (restoreError) {
        recovery.push(reportFailure(restoreError, "The previous container could not be restarted"));
      }
    }
    if (renamed && recovery.length === 0 && options.onRestored) {
      try {
        await options.onRestored(containerIdentity(before.Id, await original.inspect()));
      } catch (restoreError) {
        recovery.push(reportFailure(restoreError, "The previous service routes and runtime record could not be restored"));
      }
    }
    if (recovery.length > 0) {
      throw new AppError(
        `Environment apply failed and the previous service could not be fully restored: ${failure}. ${recovery.join("; ")}`,
        503,
        "SERVICE_ENVIRONMENT_RECOVERY_FAILED",
      );
    }
    throw new AppError(
      `Environment changes were not applied; the previous service configuration was preserved. ${failure}`,
      502,
      "SERVICE_ENVIRONMENT_APPLY_FAILED",
    );
  }
}
