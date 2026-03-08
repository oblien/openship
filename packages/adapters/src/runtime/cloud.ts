/**
 * Cloud runtime — delegates build/deploy to Oblien cloud infrastructure.
 *
 * All operations are API calls to the Oblien platform. No local Docker or
 * process management needed. This is what powers the hosted SaaS version.
 */

import type {
  BuildConfig,
  DeployConfig,
  BuildResult,
  DeploymentResult,
  LogEntry,
  LogCallback,
  ContainerInfo,
  ResourceUsage,
} from "../types";

import type { RuntimeAdapter, RuntimeCapability } from "./types";

export class CloudRuntime implements RuntimeAdapter {
  readonly name = "cloud";
  readonly capabilities: ReadonlySet<RuntimeCapability> = new Set<RuntimeCapability>([
    "build",
    "deploy",
    "stop",
    "start",
    "restart",
    "destroy",
    "containerInfo",
    "runtimeLogs",
    "usage",
  ]);

  constructor(
    private readonly apiUrl: string,
    private readonly apiKey: string,
  ) {}

  supports(cap: RuntimeCapability): boolean {
    return this.capabilities.has(cap);
  }

  async dispose(): Promise<void> {
    // No persistent connections to clean up
  }

  // ── Build lifecycle ────────────────────────────────────────────────────

  async build(config: BuildConfig, onLog?: LogCallback): Promise<BuildResult> {
    // TODO: POST /builds to Oblien API
    void onLog;
    return { sessionId: config.sessionId, status: "queued" };
  }

  async cancelBuild(sessionId: string): Promise<void> {
    // TODO: DELETE /builds/:sessionId
    void sessionId;
  }

  async getBuildLogs(sessionId: string): Promise<LogEntry[]> {
    // TODO: GET /builds/:sessionId/logs
    void sessionId;
    return [];
  }

  // ── Deploy lifecycle ───────────────────────────────────────────────────

  async deploy(config: DeployConfig): Promise<DeploymentResult> {
    // TODO: POST /deployments to Oblien API
    return {
      deploymentId: config.deploymentId,
      url: `https://${config.projectId}.openship.cloud`,
      status: "queued",
    };
  }

  async stop(containerId: string): Promise<void> {
    // TODO: POST /containers/:id/stop
    void containerId;
  }

  async start(containerId: string): Promise<void> {
    // TODO: POST /containers/:id/start
    void containerId;
  }

  async restart(containerId: string): Promise<void> {
    // TODO: POST /containers/:id/restart
    void containerId;
  }

  async destroy(containerId: string): Promise<void> {
    // TODO: DELETE /containers/:id
    void containerId;
  }

  // ── Observability ──────────────────────────────────────────────────────

  async getContainerInfo(containerId: string): Promise<ContainerInfo> {
    // TODO: GET /containers/:id
    return { containerId, status: "stopped" };
  }

  async getRuntimeLogs(containerId: string, _tail?: number): Promise<LogEntry[]> {
    // TODO: GET /containers/:id/logs
    void containerId;
    return [];
  }

  async getUsage(containerId: string): Promise<ResourceUsage> {
    // TODO: GET /containers/:id/usage
    void containerId;
    return { cpuPercent: 0, memoryMb: 0, diskMb: 0, networkRxBytes: 0, networkTxBytes: 0 };
  }

  // ── Network ────────────────────────────────────────────────────────────

  async getContainerIp(containerId: string): Promise<string | null> {
    // TODO: GET /containers/:id/network — cloud manages networking
    void containerId;
    return null;
  }
}
