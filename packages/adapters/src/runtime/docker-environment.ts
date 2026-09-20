import type Dockerode from "dockerode";
import { AppError, isValidEnvKey, safeErrorMessage } from "@repo/core";
import { randomUUID } from "node:crypto";
import { isRuntimeNotFoundError } from "../system/errors";

export interface DockerEnvironmentResult {
  containerId: string;
  ip?: string;
  warning?: string;
}

export interface DockerEnvironmentOptions {
  projectId: string;
  serviceName: string;
  /** Last recorded IP also covers a stopped container whose inspect has no IP. */
  previousIp?: string | null;
  /** Persist the new runtime identity before discarding the recoverable original. */
  onReplaced: (result: DockerEnvironmentResult) => Promise<void>;
}

function conflict(message: string): never {
  throw new AppError(message, 409, "SERVICE_ENVIRONMENT_UNAVAILABLE");
}

/** Replace only a container's environment. No build, image pull, or VM operation.
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
      throw new AppError(`Invalid runtime environment variable "${key}".`, 400, "INVALID_ENVIRONMENT");
    }
  }
  const original = docker.getContainer(containerId);
  const before = await original.inspect();
  const labels = before.Config.Labels ?? {};
  if (
    (labels["openship.project"] && labels["openship.project"] !== options.projectId) ||
    (labels["openship.service"] && labels["openship.service"] !== options.serviceName)
  ) conflict("The running container does not belong to this service.");
  if (before.State.Paused || before.HostConfig.AutoRemove) {
    conflict("This container cannot apply environment changes in place. Unpause it or use Redeploy.");
  }
  if (!before.Image) conflict("The running service's image could not be identified. Use Redeploy.");

  // The immutable image ID comes from the live container, never a mutable tag
  // or the previous deployment's possibly stale local build tag. A daemon/auth
  // failure must propagate; it is not evidence that we should try Docker Hub.
  try {
    await docker.getImage(before.Image).inspect();
  } catch (error) {
    if (isRuntimeNotFoundError(error)) {
      conflict("The running service's image is no longer available on this target. Use Redeploy to rebuild it.");
    }
    throw error;
  }

  const name = before.Name.replace(/^\//, "");
  const networkMode = before.HostConfig.NetworkMode ?? "default";
  const sharedNetwork = networkMode.startsWith("container:");
  const networks = Object.entries(before.NetworkSettings.Networks ?? {});
  // Built-in bridge networks cannot reserve a requested IP. Managed services
  // use a project network; refusing here preserves existing IP-based routes on
  // an adopted default-bridge container instead of leaving them pointing away.
  if (networks.some(([network]) => network === "bridge")) {
    conflict("This service uses Docker's default bridge. Use Redeploy to apply its environment and update routing.");
  }
  const endpointSettings = Object.fromEntries(networks
    .filter(([network]) => network !== "host" && network !== "none")
    .map(([network, endpoint]) => {
      const driverOpts = (endpoint as typeof endpoint & { DriverOpts?: Record<string, string> }).DriverOpts;
      const address = endpoint.IPAddress || endpoint.IPAMConfig?.IPv4Address ||
        (networks.length === 1 ? options.previousIp : undefined);
      const addressV6 = endpoint.GlobalIPv6Address || endpoint.IPAMConfig?.IPv6Address;
      return [network, {
        IPAMConfig: {
          ...endpoint.IPAMConfig,
          ...(address ? { IPv4Address: address } : {}),
          ...(addressV6 ? { IPv6Address: addressV6 } : {}),
        },
        Aliases: (endpoint.Aliases ?? []).filter((alias: string) => alias !== before.Id && alias !== before.Id.slice(0, 12)),
        ...(endpoint.Links ? { Links: endpoint.Links } : {}),
        ...(driverOpts ? { DriverOpts: driverOpts } : {}),
      }];
    }));

  // Reuse image-declared anonymous volumes too. Replaying Config.Volumes alone
  // creates empty anonymous volumes, even when all explicit binds are retained.
  const hostConfig = structuredClone(before.HostConfig);
  const binds = [...(hostConfig.Binds ?? [])];
  const mounted = new Set([
    ...binds.map(bind => bind.split(":")[1]),
    ...(hostConfig.Mounts ?? []).map(mount => mount.Target),
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
    name,
    Image: before.Image,
    Env: Object.entries(environment).map(([key, value]) => `${key}=${value}`),
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
  try {
    if (wasRunning) {
      // stop() honors the configured signal/grace period and Docker's default
      // SIGTERM/10s when none was specified. Never force-remove the live app.
      await original.stop();
      stopped = true;
    }
    await original.rename({ name: `${name}-env-backup-${randomUUID().slice(0, 8)}` });
    renamed = true;
    for (const network of Object.keys(endpointSettings)) {
      await docker.getNetwork(network).disconnect({ Container: before.Id });
      disconnected.push(network);
    }
    replacement = await docker.createContainer(create);
    await replacement.start();
    // Docker acknowledges start before PID 1 has read its environment. Catch an
    // immediate startup exit before discarding the recoverable old container.
    await new Promise(resolve => setTimeout(resolve, 1000));
    const after = await replacement.inspect();
    if (!after.State.Running || after.State.Restarting || after.State.Health?.Status === "unhealthy") {
      throw new Error("The service did not start with the new environment.");
    }
    const ip = Object.values(after.NetworkSettings.Networks ?? {})
      .map(network => network.IPAddress).find(Boolean);
    const result: DockerEnvironmentResult = { containerId: replacement.id, ...(ip ? { ip } : {}) };
    await options.onReplaced(result);

    // The replacement is serving and its identity is durable. Cleanup failure
    // must not roll back a committed apply or report that the env was not applied.
    try { await original.remove(); }
    catch { result.warning = "Environment applied, but the stopped previous container could not be removed."; }
    return result;
  } catch (error) {
    const recovery: string[] = [];
    if (replacement) {
      try {
        await replacement.stop().catch(err => {
          if ((err as { statusCode?: number }).statusCode !== 304 && !isRuntimeNotFoundError(err)) throw err;
        });
        await replacement.remove();
      } catch (restoreError) { recovery.push(safeErrorMessage(restoreError)); }
    }
    if (renamed) {
      try { await original.rename({ name }); }
      catch (restoreError) { recovery.push(safeErrorMessage(restoreError)); }
    }
    for (const network of disconnected) {
      try {
        await docker.getNetwork(network).connect({ Container: before.Id, EndpointConfig: endpointSettings[network] });
      } catch (restoreError) { recovery.push(safeErrorMessage(restoreError)); }
    }
    if (stopped && recovery.length === 0) {
      try { await original.start(); }
      catch (restoreError) { recovery.push(safeErrorMessage(restoreError)); }
    }
    if (recovery.length > 0) {
      throw new AppError(
        `Environment apply failed and the previous service could not be fully restored: ${safeErrorMessage(error)}. ${recovery.join("; ")}`,
        503, "SERVICE_ENVIRONMENT_RECOVERY_FAILED",
      );
    }
    throw new AppError(
      `Environment changes were not applied; the previous service configuration was preserved. ${safeErrorMessage(error)}`,
      502, "SERVICE_ENVIRONMENT_APPLY_FAILED",
    );
  }
}
