import type Dockerode from "dockerode";
import { AppError, parseComposeDurationNs, parseVolumeMount, isHostPathSource } from "@repo/core";
import { parsePortBindings, toDockerHealthcheck } from "../docker";
import { splitRuntimeEnv } from "../runtime-env";
import type { MultiServiceDeployConfig } from "../types";

/** Refuse unsupported contracts before stopping any previous release. */
export function assertSwarmServiceConfig(
  config: Pick<MultiServiceDeployConfig, "advanced" | "ports" | "namespaces" | "restart"> & {
    volumes?: string[];
    resources?: MultiServiceDeployConfig["resources"];
  },
) {
  if (config.resources?.swapDisabled || config.advanced?.resources?.swapDisabled)
    throw new AppError(
      "Docker Swarm cannot enforce per-service swap settings. Remove Disable swap or use a standalone Docker target.",
      422,
      "SWARM_SETTING_UNSUPPORTED",
    );
  for (const volume of config.volumes ?? []) {
    const mount = parseVolumeMount(volume);
    if (
      (mount.source && isHostPathSource(mount.source)) ||
      mount.options.some((option) => !["rw", "ro", "nocopy"].includes(option))
    )
      throw new AppError(
        "Swarm storage requires named volumes; host paths and SELinux flags cannot be scheduled safely.",
        422,
        "SWARM_SETTING_UNSUPPORTED",
      );
  }
  const paths = new Set<string>();
  for (const file of config.advanced?.files ?? []) {
    if (
      !file.path.startsWith("/") ||
      file.path.includes("\0") ||
      file.path.split("/").includes("..") ||
      paths.has(file.path) ||
      Buffer.byteLength(file.content) > 500_000
    )
      throw new AppError(
        "Swarm config files need unique absolute paths and must be smaller than 500 KB.",
        422,
        "SWARM_SETTING_UNSUPPORTED",
      );
    paths.add(file.path);
  }
  for (const key of ["gpus", "runtime", "shmSize", "networkMode", "pidMode"] as const) {
    if (config.advanced?.[key] !== undefined)
      throw new AppError(
        `Docker Swarm deployments do not support ${key}. Remove it or use a standalone Docker target.`,
        422,
        "SWARM_SETTING_UNSUPPORTED",
      );
  }
  if (config.namespaces && Object.values(config.namespaces).some(Boolean))
    throw new AppError(
      "Shared process/network namespaces are not supported by Docker Swarm.",
      422,
      "SWARM_SETTING_UNSUPPORTED",
    );
  if (config.restart && !["always", "unless-stopped", "on-failure", "no"].includes(config.restart))
    throw new AppError(
      "This restart policy cannot be represented by Docker Swarm.",
      422,
      "SWARM_SETTING_UNSUPPORTED",
    );
  for (const port of config.ports) {
    if (!/^(?:(?:127\.0\.0\.1|0\.0\.0\.0):)?(?:\d+:)?\d+(?:\/(?:tcp|udp))?$/.test(port))
      throw new AppError(
        "Swarm ports must be individual TCP/UDP ports, with optional loopback or public manager bindings.",
        422,
        "SWARM_SETTING_UNSUPPORTED",
      );
    const values = port
      .replace(/^(?:127\.0\.0\.1|0\.0\.0\.0):/, "")
      .split("/")[0]!
      .split(":")
      .map(Number);
    if (values.some((value) => value < 1 || value > 65535))
      throw new AppError("Choose ports between 1 and 65535.", 422, "SWARM_SETTING_UNSUPPORTED");
  }
  for (const [host, ip] of Object.entries(config.advanced?.extraHosts ?? {}))
    if (!/^[a-zA-Z0-9_.-]+$/.test(host) || !/^[0-9a-fA-F:.]+$/.test(ip))
      throw new AppError(
        "Swarm extra hosts require literal addresses; host-gateway is node-specific.",
        422,
        "SWARM_SETTING_UNSUPPORTED",
      );
}

export function swarmContainerSpec(
  config: MultiServiceDeployConfig,
  image: Dockerode.ImageInspectInfo,
): Dockerode.ContainerSpec {
  assertSwarmServiceConfig(config);
  const advanced = config.advanced;
  const env = splitRuntimeEnv(config.environment);
  const args =
    config.commandArgv ?? (config.command?.trim() ? ["sh", "-c", config.command] : undefined);
  const command = advanced?.entrypoint;
  // An explicitly empty entrypoint needs the authored CMD as the executable.
  const clearEntrypoint = command?.length === 0;
  const combined = clearEntrypoint ? (args ?? image.Config?.Cmd ?? []) : undefined;
  if (clearEntrypoint && !combined?.length)
    throw new AppError("An empty entrypoint requires a command.", 422, "SWARM_SETTING_UNSUPPORTED");
  return {
    Image: config.image,
    Env: env.entries.map(([key, value]) => `${key}=${value}`),
    ...(command !== undefined ? { Command: clearEntrypoint ? [combined![0]!] : command } : {}),
    ...(clearEntrypoint ? { Args: combined!.slice(1) } : args !== undefined ? { Args: args } : {}),
    ...(advanced?.healthcheck ? { Healthcheck: toDockerHealthcheck(advanced.healthcheck) } : {}),
    ...(advanced?.stopSignal ? { StopSignal: advanced.stopSignal } : {}),
    ...(advanced?.stopGracePeriod
      ? { StopGracePeriod: parseComposeDurationNs(advanced.stopGracePeriod) }
      : {}),
    ...(advanced?.extraHosts
      ? { Hosts: Object.entries(advanced.extraHosts).map(([host, ip]) => `${ip} ${host}`) }
      : {}),
  };
}

export function swarmGatewayPorts(config: MultiServiceDeployConfig) {
  const parsed = parsePortBindings(config.ports);
  const ports = new Set(Object.keys(parsed.exposedPorts));
  for (const port of [
    config.publicPort,
    ...(config.routedPorts ?? []),
    ...(config.cloudProxyPorts ?? []),
    ...(config.cloudEndpoints ?? []).map((item) => item.port),
  ])
    if (port) ports.add(`${port}/tcp`);
  return { ...parsed, ports: [...ports].sort() };
}

/** Minimal private TCP/UDP bridge; the shared Edge still owns HTTP, TLS and policy. */
export function swarmGatewayConfig(serviceName: string, ports: readonly string[]): string {
  if (!/^[a-z0-9-]+$/.test(serviceName)) throw new Error("Invalid Swarm service identity");
  const servers = ports.map((value) => {
    const [port, protocol] = value.split("/");
    if (!/^\d+$/.test(port!) || !["tcp", "udp"].includes(protocol!))
      throw new Error("Invalid gateway port");
    return `server { listen ${port}${protocol === "udp" ? " udp" : ""}; proxy_pass ${serviceName}:${port}; proxy_connect_timeout 5s; proxy_timeout 1h; }`;
  });
  return `worker_processes 1; error_log /dev/stderr warn; pid /tmp/nginx.pid; events { worker_connections 1024; } stream { ${servers.join("\n")} }`;
}
