import type { CommandExecutor } from "../../types";
import { sq } from "../git-clone";
import {
  groupSwarmStacks,
  normalizeSwarmManagerInfo,
  normalizeSwarmNamedObject,
  normalizeSwarmNetwork,
  normalizeSwarmNode,
  normalizeSwarmService,
  normalizeSwarmTask,
  normalizeSwarmVolume,
  SwarmProbeError,
} from "./normalize";
import type {
  StackRuntimeAdapter,
  SwarmDiscoveryDiagnostic,
  SwarmDiscoverySnapshot,
  SwarmManagerInfo,
} from "./types";

export interface SwarmRuntimeOptions {
  executor: Pick<CommandExecutor, "exec">;
  /** Bounded so a failed manager/SSH link cannot pin an API request. */
  timeoutMs?: number;
  /** Bound a malformed/large manager response before it reaches an API payload. */
  maxResources?: number;
}

/**
 * Manager-scoped Swarm CLI adapter. It deliberately starts read-only: no stack
 * command is available until source rendering and managed-stack claim gates are
 * implemented. The executor is shared with the Platform and is not disposed.
 */
export class SwarmRuntime implements StackRuntimeAdapter {
  readonly name = "swarm" as const;
  private readonly timeoutMs: number;
  private readonly maxResources: number;

  private constructor(private readonly executor: Pick<CommandExecutor, "exec">, options: SwarmRuntimeOptions) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxResources = options.maxResources ?? 250;
  }

  static async create(options: SwarmRuntimeOptions): Promise<SwarmRuntime> {
    const runtime = new SwarmRuntime(options.executor, options);
    await runtime.probe();
    return runtime;
  }

  async probe(): Promise<SwarmManagerInfo> {
    let infoText: string;
    let serverText: string;
    try {
      infoText = await this.executor.exec("docker info --format '{{json .}}'", {
        timeout: this.timeoutMs,
      });
      serverText = await this.executor.exec("docker version --format '{{json .Server}}'", {
        timeout: this.timeoutMs,
      });
    } catch {
      throw new SwarmProbeError(
        "SWARM_MANAGER_UNREACHABLE",
        "Unable to reach Docker on this target. Verify the manager connection and Docker permissions.",
      );
    }

    try {
      return normalizeSwarmManagerInfo(JSON.parse(infoText), JSON.parse(serverText));
    } catch (err) {
      if (err instanceof SwarmProbeError) throw err;
      throw new SwarmProbeError(
        "SWARM_INVALID_INFO",
        "Docker returned an unreadable manager response while probing Docker Swarm.",
      );
    }
  }

  /**
   * Read the manager's operational shape. Every command is read-only, parsed
   * locally, and bounded. A failed optional listing becomes a diagnostic rather
   * than turning a healthy manager into a false negative.
   */
  async discover(): Promise<SwarmDiscoverySnapshot> {
    const manager = await this.probe();
    const diagnostics: SwarmDiscoveryDiagnostic[] = [];
    const observedAt = new Date().toISOString();

    const nodes = (await this.readJsonLines("docker node ls --format '{{json .}}'", "nodes", diagnostics))
      .slice(0, this.maxResources)
      .map(normalizeSwarmNode)
      .filter((node) => node.id);

    const serviceIds = await this.readLines("docker service ls -q", "services", diagnostics);
    if (serviceIds.length > this.maxResources) {
      diagnostics.push({ resource: "services", message: `Discovery capped at ${this.maxResources} services.` });
    }
    const services = [];
    for (const serviceId of serviceIds.slice(0, this.maxResources)) {
      const rows = await this.readJsonLines(
        `docker service inspect --format '{{json .}}' ${sq(serviceId)}`,
        "services",
        diagnostics,
      );
      for (const row of rows) {
        const service = normalizeSwarmService(row);
        if (service.id) services.push(service);
      }
    }

    const tasks = [];
    for (const service of services) {
      const rows = await this.readJsonLines(
        `docker service ps ${sq(service.id)} --no-trunc --format '{{json .}}'`,
        "tasks",
        diagnostics,
      );
      for (const row of rows.slice(0, this.maxResources)) {
        const task = normalizeSwarmTask(row, service, observedAt);
        if (task.id) tasks.push(task);
      }
    }

    const networks = (await this.readJsonLines("docker network ls --filter scope=swarm --format '{{json .}}'", "networks", diagnostics))
      .slice(0, this.maxResources)
      .map(normalizeSwarmNetwork)
      .filter((network) => network.id);
    const volumes = (await this.readJsonLines("docker volume ls --format '{{json .}}'", "volumes", diagnostics))
      .slice(0, this.maxResources)
      .map(normalizeSwarmVolume)
      .filter((volume) => volume.name);
    const configs = (await this.readJsonLines("docker config ls --format '{{json .}}'", "configs", diagnostics))
      .slice(0, this.maxResources)
      .map(normalizeSwarmNamedObject)
      .filter((config) => config.id && config.name);
    // `docker secret ls` intentionally lists metadata only. Never inspect a
    // secret: the payload is not useful for discovery and must not enter memory.
    const secrets = (await this.readJsonLines("docker secret ls --format '{{json .}}'", "secrets", diagnostics))
      .slice(0, this.maxResources)
      .map(normalizeSwarmNamedObject)
      .filter((secret) => secret.id && secret.name);

    return {
      manager,
      nodes,
      stacks: groupSwarmStacks(services),
      services,
      tasks,
      networks,
      volumes,
      configs,
      secrets,
      diagnostics,
      observedAt,
    };
  }

  private async readLines(
    command: string,
    resource: SwarmDiscoveryDiagnostic["resource"],
    diagnostics: SwarmDiscoveryDiagnostic[],
  ): Promise<string[]> {
    try {
      const output = await this.executor.exec(command, { timeout: this.timeoutMs });
      return output.split("\n").map((line) => line.trim()).filter(Boolean);
    } catch {
      diagnostics.push({ resource, message: `Unable to list Swarm ${resource} from this manager.` });
      return [];
    }
  }

  private async readJsonLines(
    command: string,
    resource: SwarmDiscoveryDiagnostic["resource"],
    diagnostics: SwarmDiscoveryDiagnostic[],
  ): Promise<unknown[]> {
    const lines = await this.readLines(command, resource, diagnostics);
    const result: unknown[] = [];
    for (const line of lines) {
      try {
        result.push(JSON.parse(line));
      } catch {
        diagnostics.push({ resource, message: `Manager returned an unreadable ${resource} record.` });
      }
    }
    return result;
  }

  async dispose(): Promise<void> {
    // The caller owns the platform executor/SSH transport; no-op by design.
  }
}
