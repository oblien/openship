import type { Oblien, WorkspaceHandle } from "oblien";

import { DEFAULT_RESOURCE_CONFIG, cloudCpus, type LogCallback, type ResourceConfig } from "../../types";
import type { WorkspaceRuntimePlan } from "../../dockerfile";
import { sq, type BuildLogger } from "../build-pipeline";
import { SYSTEM, safeErrorMessage } from "@repo/core";
import type {
  MultiServiceDeployConfig,
  MultiServiceDeployResult,
  MultiServiceGroupHandle,
} from "../types";

type CloudWorkspaceRuntime = Awaited<ReturnType<WorkspaceHandle["runtime"]>>;

export interface CloudBuiltArtifact {
  workspaceId: string;
  runtime: WorkspaceRuntimePlan;
}

interface CloudComposeServiceState {
  serviceName: string;
  workspaceId: string;
  ip?: string;
  ports: number[];
}

interface CloudComposeGroupState {
  id: string;
  resources?: ResourceConfig;
  services: Map<string, CloudComposeServiceState>;
}

interface CloudComposeSupportDeps {
  client: Oblien;
  builtArtifacts: Map<string, CloudBuiltArtifact>;
  workspace(workspaceId: string): WorkspaceHandle;
  provisionWorkspace(
    config: {
      name: string;
      image: string;
      mode: "temporary" | "permanent";
      resources: ResourceConfig;
      env?: Record<string, string>;
      ttl?: string;
    },
    logger: BuildLogger,
  ): Promise<{ workspaceId: string; runtime: CloudWorkspaceRuntime }>;
  execAndStream(
    runtime: CloudWorkspaceRuntime,
    command: string[],
    onLog: LogCallback,
    timeoutSeconds?: number,
  ): Promise<void>;
}

function now(): string {
  return new Date().toISOString();
}

function toEnvArray(env: Record<string, string>): string[] {
  return Object.entries(env).map(([k, v]) => `${k}=${v}`);
}

function firstContainerPort(portSpecs: string[]): number | undefined {
  for (const spec of portSpecs) {
    const clean = spec.trim();
    if (!clean) continue;
    const parts = clean.split(":");
    const raw = parts.length >= 2 ? parts[parts.length - 1] : parts[0];
    const match = raw?.match(/^(\d+)(?:\/(?:tcp|udp))?$/i);
    if (match) return Number(match[1]);
  }
  return undefined;
}

export function restartPolicyForWorkload(policy?: string): "always" | "on-failure" | "never" {
  const base = policy?.split(":")[0];
  if (base === "no" || base === "never") return "never";
  if (base === "on-failure") return "on-failure";
  return "always";
}

function exposeTarget(port: number, serviceName: string, slug?: string, domain: string = SYSTEM.DOMAINS.CLOUD_DOMAIN) {
  const service = `service "${serviceName}" on port ${port}`;
  return slug ? `${service} for slug "${slug}" (${slug}.${domain})` : service;
}

function errorMessage(err: unknown) {
  return safeErrorMessage(err);
}

async function withCloudOperationTimeout<T>(
  operation: Promise<T>,
  label: string,
  timeoutMs = 300_000,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class CloudComposeSupport {
  private readonly groups = new Map<string, CloudComposeGroupState>();

  constructor(private readonly deps: CloudComposeSupportDeps) {}

  async ensureServiceGroup(config: {
    deploymentId: string;
    projectId: string;
    slug: string;
    resources?: ResourceConfig;
  }): Promise<MultiServiceGroupHandle> {
    const id = `cloud-compose:${config.deploymentId}`;
    if (!this.groups.has(id)) {
      this.groups.set(id, {
        id,
        resources: config.resources,
        services: new Map(),
      });
    }
    return { id };
  }

  /** Seed an already-running peer into the group WITHOUT deploying it, so the
   *  next finalizeGroup rewrites the full mesh (/etc/hosts + private links)
   *  including it. Used by the decoupled single-service add — only the new
   *  service is deployed, but its peers must remain reachable by name. */
  registerExistingWorkload(
    group: MultiServiceGroupHandle,
    service: { serviceName: string; workspaceId: string; ip?: string; portSpecs?: string[] },
  ): void {
    const groupState = this.groups.get(group.id);
    if (!groupState) return;
    // Never clobber a service that was actually (re)deployed this run.
    if (groupState.services.has(service.serviceName)) return;
    const ports = [
      ...new Set(
        (service.portSpecs ?? [])
          .map((item) => firstContainerPort([item]))
          .filter((item): item is number => typeof item === "number"),
      ),
    ];
    groupState.services.set(service.serviceName, {
      serviceName: service.serviceName,
      workspaceId: service.workspaceId,
      ip: service.ip,
      ports,
    });
  }

  async deployServiceWorkload(
    group: MultiServiceGroupHandle,
    config: MultiServiceDeployConfig,
    onLog?: LogCallback,
  ): Promise<MultiServiceDeployResult> {
    const log = onLog ?? (() => {});
    const groupState = this.groups.get(group.id) ?? {
      id: group.id,
      services: new Map<string, CloudComposeServiceState>(),
    };
    this.groups.set(group.id, groupState);

    const builtArtifact = this.deps.builtArtifacts.get(config.image);
    let workspaceId: string | undefined;

    try {
      workspaceId =
        builtArtifact?.workspaceId ?? (await this.createImageServiceWorkspace(config, log));
      const ws = this.deps.workspace(workspaceId);

      // A source-built server reuses its build workspace as the runtime, so it
      // must be shrunk from the build tier to its production tier before going
      // live (mandatory — see shrinkToRuntimeTier). Image services skip this:
      // createImageServiceWorkspace already sized them at the prod tier.
      if (builtArtifact?.workspaceId) {
        await this.shrinkToRuntimeTier(ws, config, log);
      }

      await withCloudOperationTimeout(
        ws.lifecycle.makePermanent(),
        `Making cloud service "${config.serviceName}" permanent`,
      ).catch((err) => {
        throw new Error(`Failed to make service workspace permanent: ${errorMessage(err)}`);
      });
      const runtimeEnv = {
        ...(builtArtifact?.runtime.env ?? {}),
        ...config.environment,
      };
      const port =
        config.publicPort ?? firstContainerPort(config.ports) ?? builtArtifact?.runtime.exposedPort;
      const workdir = builtArtifact?.runtime.workdir ?? "/";
      const startCommand = config.command ?? builtArtifact?.runtime.startCommand;

      log({
        timestamp: now(),
        message: `Deploying cloud service "${config.serviceName}" in workspace ${workspaceId}...\n`,
        level: "info",
      });

      if (startCommand) {
        log({
          timestamp: now(),
          message: `Creating workload for service "${config.serviceName}"...\n`,
          level: "info",
        });
        await withCloudOperationTimeout(
          ws.workloads.delete("app").catch(() => {}),
          `Replacing workload for service "${config.serviceName}"`,
        );
        await withCloudOperationTimeout(
          ws.workloads.create({
            id: "app",
            name: "app",
            cmd: ["sh", "-c", `cd ${sq(workdir)} && ${startCommand}`],
            working_dir: workdir,
            env: [...toEnvArray(runtimeEnv), ...(port ? [`PORT=${port}`] : [])],
            restart_policy: restartPolicyForWorkload(config.restart),
            max_restarts: 10,
          }),
          `Creating workload for service "${config.serviceName}"`,
        );
        log({
          timestamp: now(),
          message: `Workload for service "${config.serviceName}" is ready.\n`,
          level: "info",
        });
      } else {
        log({
          timestamp: now(),
          message: `No command configured for "${config.serviceName}". Using the workspace image default process.\n`,
          level: "warn",
        });
      }

      if (config.expose && port) {
        if (config.customDomain) {
          log({
            timestamp: now(),
            message: `Opening ${exposeTarget(port, config.serviceName, config.publicSlug)}...\n`,
            level: "info",
          });
          await withCloudOperationTimeout(
            ws.network.update({ ingress_ports: [port] }),
            `Opening network port for service "${config.serviceName}"`,
          ).catch((err) => {
            throw new Error(
              `Failed to open ${exposeTarget(port, config.serviceName, config.publicSlug)}: ${errorMessage(err)}`,
            );
          });
          log({
            timestamp: now(),
            message: `Opened ${exposeTarget(port, config.serviceName, config.publicSlug)}.\n`,
            level: "info",
          });
          log({
            timestamp: now(),
            message: `Connecting custom domain "${config.customDomain}" for service "${config.serviceName}"...\n`,
            level: "info",
          });
          await withCloudOperationTimeout(
            ws.domains.connect({ domain: config.customDomain, port }),
            `Connecting custom domain for service "${config.serviceName}"`,
          ).catch((err) => {
            throw new Error(
              `Failed to connect custom domain "${config.customDomain}" for service "${config.serviceName}" on port ${port}: ${errorMessage(err)}`,
            );
          });
          log({
            timestamp: now(),
            message: `Custom domain "${config.customDomain}" connected for service "${config.serviceName}".\n`,
            level: "info",
          });
        } else if (config.publicSlug) {
          log({
            timestamp: now(),
            message: `Exposing ${exposeTarget(port, config.serviceName, config.publicSlug)}...\n`,
            level: "info",
          });
          await withCloudOperationTimeout(
            ws.publicAccess.expose({
              port,
              domain: SYSTEM.DOMAINS.CLOUD_DOMAIN,
              slug: config.publicSlug,
            }),
            `Exposing public access for service "${config.serviceName}"`,
          ).catch((err) => {
            throw new Error(
              `Failed to expose ${exposeTarget(port, config.serviceName, config.publicSlug)}: ${errorMessage(err)}`,
            );
          });
          log({
            timestamp: now(),
            message: `Exposed ${exposeTarget(port, config.serviceName, config.publicSlug)}.\n`,
            level: "info",
          });
        }
      }

      const ip = await this.resolveWorkspaceIpWithRetry(ws);
      const ports = [
        ...new Set([
          ...config.ports
            .map((item) => firstContainerPort([item]))
            .filter((item): item is number => typeof item === "number"),
          ...(port ? [port] : []),
        ]),
      ];

      groupState.services.set(config.serviceName, {
        serviceName: config.serviceName,
        workspaceId,
        ip: ip ?? undefined,
        ports,
      });

      await this.syncServiceDiscovery(groupState, log);

      log({
        timestamp: now(),
        message: `Cloud service "${config.serviceName}" started${ip ? ` at ${ip}` : ""}.\n`,
        level: "info",
      });

      return {
        containerId: workspaceId,
        status: "running",
        ip: ip ?? undefined,
        hostPort: port,
      };
    } catch (err) {
      if (workspaceId) {
        groupState.services.delete(config.serviceName);
        await this.deps
          .workspace(workspaceId)
          .delete()
          .catch(() => {});
      }
      throw err;
    }
  }

  /**
   * Shrink a source-built server's workspace from the BUILD tier (4cpu/8GB/10GB)
   * down to its production/runtime tier. The build workspace is reused as the
   * runtime, so without this every deployed app holds build-sized resources
   * permanently and saturates the cloud pool — new builds then fail to place
   * (CREATE_FAILED).
   *
   * Mandatory by design: a resize failure THROWS and fails the deploy. Leaving a
   * service oversized is not an acceptable escape hatch — it silently poisons the
   * shared pool. (cpu + memory are the pool/cost constraint; disk isn't in the
   * deploy config and shrinking a data volume is unreliable, so it's left alone.)
   */
  private async shrinkToRuntimeTier(
    ws: WorkspaceHandle,
    config: MultiServiceDeployConfig,
    log: LogCallback,
  ): Promise<void> {
    const cpus = cloudCpus(config.resources?.cpuCores ?? DEFAULT_RESOURCE_CONFIG.cpuCores);
    const memory_mb = config.resources?.memoryMb ?? DEFAULT_RESOURCE_CONFIG.memoryMb;
    try {
      await withCloudOperationTimeout(
        ws.resources.update({ cpus, memory_mb, apply: true }),
        `Resizing service "${config.serviceName}" to its runtime tier`,
      );
    } catch (err) {
      throw new Error(
        `Failed to shrink service "${config.serviceName}" from the build tier to its runtime tier: ${errorMessage(err)}`,
      );
    }
    log({
      timestamp: now(),
      message: `Sized "${config.serviceName}" to its runtime tier (${cpus} vCPU · ${memory_mb} MB).\n`,
      level: "info",
    });
  }

  private async createImageServiceWorkspace(
    config: MultiServiceDeployConfig,
    onLog: LogCallback,
  ): Promise<string> {
    // Reuse the workspace from the previous deploy when it still exists — the
    // permanent-workspace disk is the ONLY persistence Oblien offers (no volume
    // primitive), so recreating it every deploy silently wipes a stateful
    // service's data. Keeping the same workspace keeps its disk.
    if (config.previousWorkspaceId) {
      try {
        const existing = this.deps.workspace(config.previousWorkspaceId);
        await existing.get(); // 404s if it was reaped
        onLog({
          timestamp: now(),
          message: `Reusing existing workspace ${config.previousWorkspaceId} for service "${config.serviceName}" (preserves its disk/data).\n`,
          level: "info",
        });
        return config.previousWorkspaceId;
      } catch {
        onLog({
          timestamp: now(),
          message: `Previous workspace for "${config.serviceName}" is gone — creating a fresh one (its prior data is not recoverable).\n`,
          level: "warn",
        });
      }
    }

    // A declared volume means the service stores data — size the disk above the
    // runtime-tier default so it isn't cramped. (Oblien has one disk per
    // workspace; there is no separate volume to size.)
    const diskMb = config.volumes.length
      ? Math.max(DEFAULT_RESOURCE_CONFIG.diskMb, 20480)
      : DEFAULT_RESOURCE_CONFIG.diskMb;
    const resources: ResourceConfig = {
      cpuCores: config.resources?.cpuCores ?? DEFAULT_RESOURCE_CONFIG.cpuCores,
      memoryMb: config.resources?.memoryMb ?? DEFAULT_RESOURCE_CONFIG.memoryMb,
      diskMb,
    };

    // Shared volumes (mounted by more than one service) and host bind-mounts
    // have no Oblien equivalent — a single named volume persists via this
    // workspace's disk, but anything cross-workspace can't. Warn instead of
    // silently pretending it worked.
    const sharedOrBind = config.volumes.filter((v) => v.includes(":/") && v.startsWith("/"));
    if (sharedOrBind.length) {
      onLog({
        timestamp: now(),
        message: `Warning: bind-mount volumes are not supported on cloud and were ignored for "${config.serviceName}": ${sharedOrBind.join(", ")}\n`,
        level: "warn",
      });
    }

    onLog({
      timestamp: now(),
      message: `Creating cloud service "${config.serviceName}" from image "${config.image}"...\n`,
      level: "info",
    });

    let wsData: { id: string };
    try {
      wsData = await this.deps.client.workspaces.create({
        name: `${config.slug}-${config.serviceName}`.slice(0, 60),
        image: config.image,
        mode: "permanent",
        config: {
          cpus: cloudCpus(resources.cpuCores),
          memory_mb: resources.memoryMb,
          disk_size_mb: resources.diskMb,
          env: toEnvArray(config.environment),
        },
      });
    } catch (err) {
      const message = safeErrorMessage(err);
      onLog({
        timestamp: now(),
        message: `Failed to create cloud service "${config.serviceName}" from image "${config.image}": ${message}\n`,
        level: "error",
      });
      throw err;
    }

    return wsData.id;
  }

  private async resolveWorkspaceIp(ws: WorkspaceHandle): Promise<string | null> {
    // Oblien's DOCUMENTED private IP — the address a peer uses over a private
    // link — comes from apiAccess.rawToken(), NOT network.get().ip (which is the
    // public/gateway IP, often unset) or ws.get().ip. Prefer it, then fall back.
    try {
      const raw = await ws.apiAccess.rawToken();
      if (raw?.ip) return raw.ip;
    } catch {
      // Fall through — rawToken can 404 briefly right after create.
    }
    try {
      const network = await ws.network.get();
      if (network.ip) return network.ip;
    } catch {
      // Fall through to workspace metadata.
    }
    try {
      const data = await ws.get();
      return ((data as Record<string, unknown>).ip as string | undefined) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Oblien may assign the private IP a beat after the workspace starts. Poll
   * (bounded) so a transient null never permanently drops a service from the
   * mesh — the original bug was resolving once with no retry.
   */
  private async resolveWorkspaceIpWithRetry(
    ws: WorkspaceHandle,
    attempts = 10,
    delayMs = 1000,
  ): Promise<string | null> {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const ip = await this.resolveWorkspaceIp(ws);
      if (ip) return ip;
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    return null;
  }

  private async syncServiceDiscovery(
    group: CloudComposeGroupState,
    onLog: LogCallback,
  ): Promise<void> {
    const services = [...group.services.values()].filter((service) => service.ip);
    if (services.length === 0) return;

    const workspaceIds = [...new Set(services.map((service) => service.workspaceId))];
    const hostsLines = services.map(
      (service) => `${service.ip} ${service.serviceName} # openship-compose:${group.id}`,
    );
    const hostsBlock = hostsLines.join("\n");

    for (const service of services) {
      const ws = this.deps.workspace(service.workspaceId);
      const privateLinks = workspaceIds.filter(
        (workspaceId) => workspaceId !== service.workspaceId,
      );
      // Open this service's own listen ports ALWAYS (even before it has peers) —
      // Oblien's firewall drops traffic unless BOTH a source rule (the private
      // link) AND a port rule (ingress_ports) match. A peer resolves
      // `http://<name>:<port>` via /etc/hosts but the packet is dropped unless
      // this port is open here. Doing it unconditionally means a service that
      // deployed before its peers isn't left with a closed port. Merge with
      // whatever is already open (public expose, etc.).
      const currentNetwork = await ws.network.get().catch(() => null);
      const currentIngress = Array.isArray(
        (currentNetwork as Record<string, unknown> | null)?.ingress_ports,
      )
        ? ((currentNetwork as Record<string, unknown>).ingress_ports as number[])
        : [];
      const ingressPorts = [...new Set([...currentIngress, ...service.ports])];
      if (ingressPorts.length > 0 || privateLinks.length > 0) {
        await ws.network
          .update({
            ...(privateLinks.length ? { private_link_ids: privateLinks } : {}),
            ...(ingressPorts.length ? { ingress_ports: ingressPorts } : {}),
          })
          .catch((err) => {
            onLog({
              timestamp: now(),
              message: `Warning: failed to link private network for "${service.serviceName}": ${err instanceof Error ? err.message : err}\n`,
              level: "warn",
            });
          });
      }

      try {
        const rt = await ws.runtime();
        const script = `set -e
tmp=$(mktemp)
grep -v ' # openship-compose:${group.id}' /etc/hosts > "$tmp" || true
cat >> "$tmp" <<'EOF'
${hostsBlock}
EOF
cat "$tmp" > /etc/hosts
rm -f "$tmp"`;
        await this.deps.execAndStream(rt, ["sh", "-c", script], onLog);
      } catch (err) {
        onLog({
          timestamp: now(),
          message: `Warning: failed to update service discovery for "${service.serviceName}": ${err instanceof Error ? err.message : err}\n`,
          level: "warn",
        });
      }
    }
  }

  /**
   * Final convergence pass — run ONCE after every service in the group has
   * deployed. The per-service `syncServiceDiscovery` is incremental and only
   * ever sees the IPs known at that moment; a service whose private IP hadn't
   * been assigned during its own deploy would otherwise stay permanently absent
   * from the mesh. This re-resolves any still-missing IP (bounded retry) and
   * rewrites the FULL /etc/hosts + private links + ingress across the whole
   * group, so the finished stack has every peer reachable by name.
   *
   * Note: we deliberately do NOT blanket-restart workloads here — that would
   * take stateful services (Postgres, …) down needlessly, and standard clients
   * resolve DNS per connection, so they read the completed /etc/hosts without a
   * restart. (A boot-time-cache app is the rare exception.)
   */
  async finalizeGroup(groupId: string, onLog?: LogCallback): Promise<void> {
    const log = onLog ?? (() => {});
    const group = this.groups.get(groupId);
    if (!group) return;

    for (const service of group.services.values()) {
      if (service.ip) continue;
      const ip = await this.resolveWorkspaceIpWithRetry(
        this.deps.workspace(service.workspaceId),
      );
      if (ip) {
        service.ip = ip;
      } else {
        log({
          timestamp: now(),
          message: `Warning: service "${service.serviceName}" never received a private IP — peers cannot reach it by name.\n`,
          level: "warn",
        });
      }
    }

    await this.syncServiceDiscovery(group, log);
  }
}
