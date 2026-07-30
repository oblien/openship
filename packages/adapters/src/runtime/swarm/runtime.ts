import type { CommandExecutor } from "../../types";
import { normalizeSwarmManagerInfo, SwarmProbeError } from "./normalize";
import type { StackRuntimeAdapter, SwarmManagerInfo } from "./types";

export interface SwarmRuntimeOptions {
  executor: Pick<CommandExecutor, "exec">;
  /** Bounded so a failed manager/SSH link cannot pin an API request. */
  timeoutMs?: number;
}

/**
 * Manager-scoped Swarm CLI adapter. It deliberately starts read-only: no stack
 * command is available until source rendering and managed-stack claim gates are
 * implemented. The executor is shared with the Platform and is not disposed.
 */
export class SwarmRuntime implements StackRuntimeAdapter {
  readonly name = "swarm" as const;
  private readonly timeoutMs: number;

  private constructor(private readonly executor: Pick<CommandExecutor, "exec">, options: SwarmRuntimeOptions) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
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

  async dispose(): Promise<void> {
    // The caller owns the platform executor/SSH transport; no-op by design.
  }
}
