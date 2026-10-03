import type { Oblien, Runtime, WorkloadInfo } from "oblien";
import { AppError } from "@repo/core";
import type { ContainerStatus, ProvisionLock } from "../../types";
import { CloudWorkspaceExecutor } from "./workspace-executor";
import { openCloudDockerStream } from "./docker-request";
import {
  CLOUD_DOCKER_BRIDGE_PORT,
  CLOUD_DOCKER_BRIDGE_SOURCE,
  CLOUD_DOCKER_BRIDGE_VERSION,
} from "./docker-bridge-source";
import {
  assertDockerWorkspaceOwner,
  assertCloudWorkspaceRunning,
  cloudWorkspaceStatus,
  isDockerWorkspaceRunning,
  waitForCloudDockerWorkspace,
} from "./workspace-ready";

export const CLOUD_SERVER_IMAGE = "oblien/docker:29";
const BRIDGE_SCRIPT = "/opt/openship/cloud-docker/bridge-v1.py";
const BRIDGE_WORKLOAD = "openship-docker-api-v1";

export interface CloudServerConnectionOptions {
  workspaceId: string;
  namespace: string;
  beforeProvision?: () => Promise<void>;
  bridgeLock?: ProvisionLock;
  provisionLock?: ProvisionLock;
}

/** Managed process listeners remain reserved while the process is stopped. */
export function managedProcessPorts(workload: WorkloadInfo): number[] {
  const labels = workload.labels as Record<string, unknown> | undefined;
  if (!labels?.["openship.project"] || !labels["openship.deployment"]) return [];
  if (typeof labels["openship.ports"] !== "string")
    throw new Error("Managed process listener metadata is missing");
  const ports: unknown = JSON.parse(labels["openship.ports"]);
  if (
    !Array.isArray(ports) ||
    ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)
  )
    throw new Error("Managed process listener metadata is invalid");
  return [...new Set(ports as number[])];
}

export function managedProcessState(workload: WorkloadInfo): ContainerStatus {
  const state = String(workload.state ?? workload.status ?? "").toLowerCase();
  if (["running", "active"].includes(state)) return "running";
  // Stopping a provider workload can record its signal exit as failed. Only a
  // terminal process with persisted enabled=false is intentionally stopped.
  if (["failed", "error", "crashed"].includes(state))
    return workload.enabled === false ? "stopped" : "failed";
  if (["starting", "pending", "created", "restarting"].includes(state)) return "deploying";
  if (["stopped", "exited", "disabled", "completed"].includes(state)) return "stopped";
  if (state === "missing") return "missing";
  throw new Error("The provider did not return a recognized application process state");
}

/** Workload GET is saved configuration and can retain an old state after a VM
 * restart. The provider's status endpoint is the live process authority. */
export async function readManagedProcessStatus(
  workloads: ReturnType<Oblien["workspace"]>["workloads"],
  saved: WorkloadInfo,
): Promise<WorkloadInfo> {
  let result: Awaited<ReturnType<typeof workloads.status>>;
  try {
    result = await workloads.status(saved.id);
  } catch (error) {
    // Disabled configurations survive a host restart without registering a live
    // process. A saved enabled process absent from the guest can be started.
    if ((error as { status?: number })?.status === 404)
      return { ...saved, state: saved.enabled === false ? "stopped" : "missing" };
    throw error;
  }
  const live = result.status as { id?: unknown; state?: unknown } | undefined;
  if (result.success !== true || !live || live.id !== saved.id || typeof live.state !== "string")
    throw new AppError("The provider did not return a live status for this application process", 502, "PROCESS_STATUS_UNAVAILABLE");
  const workload = { ...saved, state: live.state };
  managedProcessState(workload);
  return workload;
}

/** A successful control request is not proof the managed process transitioned. */
export async function waitForManagedProcess(
  read: () => Promise<WorkloadInfo>,
  expected: "running" | "stopped",
): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const state = managedProcessState(await read());
    if (state === expected || (expected === "stopped" && state === "failed")) return;
    if (expected === "running" && state === "failed")
      throw new AppError(
        "The application process failed to start. Check its runtime logs.",
        502,
        "PROCESS_START_FAILED",
      );
    if (Date.now() >= deadline)
      throw new AppError(
        `The application process did not become ${expected} within 30 seconds. Check its runtime logs and retry.`,
        504,
        "PROCESS_TRANSITION_TIMEOUT",
      );
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Health is a short protocol marker. Never retain a provider error body,
 * signed URL or an unbounded response in a deployment error. */
async function bridgeVersionMatches(response: Response): Promise<boolean> {
  const reader = response.body?.getReader();
  if (!reader) return false;
  let body = "";
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return body + decoder.decode() === CLOUD_DOCKER_BRIDGE_VERSION;
      if (value.length > 256 || body.length + value.length > 256) return false;
      body += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** Authenticated host transport. It never creates or deletes application releases. */
export class CloudServerConnection {
  readonly executor: CloudWorkspaceExecutor;
  readonly workspaceId: string;
  private bridgePromise?: Promise<void>;

  constructor(
    private readonly client: Oblien,
    private readonly options: CloudServerConnectionOptions,
  ) {
    if (!options.namespace || !options.workspaceId)
      throw new Error("Managed server requires a workspace and organization scope");
    this.workspaceId = options.workspaceId;
    this.executor = new CloudWorkspaceExecutor(() => this.runtime(), this.workspaceId);
  }

  workspace() {
    return this.client.workspace(this.workspaceId);
  }

  runtime(): Promise<Runtime> {
    // Runtime tokens are refreshed by the SDK; never cache a token in a project adapter.
    return this.workspace().runtime();
  }

  async state(): Promise<ContainerStatus> {
    const data = await this.workspace().get();
    assertDockerWorkspaceOwner(data, this.options.namespace, this.workspaceId);
    if (isDockerWorkspaceRunning(data)) return "running";
    const status = cloudWorkspaceStatus(data);
    if (["failed", "error"].includes(status)) return "failed";
    if (["starting", "creating", "provisioning", "resuming"].includes(status)) return "deploying";
    if (["stopped", "paused", "suspended"].includes(status)) return "stopped";
    throw new AppError(
      "The managed server's state is unavailable. Refresh the server and retry.",
      503,
      "CLOUD_SERVER_STATE_UNAVAILABLE",
    );
  }

  async beforeWork() {
    await this.options.beforeProvision?.();
  }

  runExclusive<T>(work: () => Promise<T>): Promise<T> {
    return this.options.provisionLock ? this.options.provisionLock.run(work) : work();
  }

  async ensureDocker() {
    await this.ensureBridge();
  }

  /** Inspect host bindings independently of the runtime selected for one project. */
  async publishedPorts(excludeBareProjectId?: string): Promise<number[]> {
    const output = await this.executor.exec(
      "docker ps -aq --no-trunc | xargs -r docker inspect --format '{{json .HostConfig.PortBindings}}'",
    );
    const ports = new Set<number>();
    for (const line of output.split("\n").filter(Boolean)) {
      const bindings = JSON.parse(line) as Record<
        string,
        Array<{ HostPort: string }> | null
      > | null;
      for (const [key, values] of Object.entries(bindings ?? {})) {
        if (!key.endsWith("/tcp")) continue;
        for (const value of values ?? []) {
          const port = Number(value.HostPort);
          if (Number.isInteger(port) && port > 0 && port <= 65535) ports.add(port);
        }
      }
    }
    for (const workload of await this.workspace().workloads.list()) {
      if (
        excludeBareProjectId &&
        (workload.labels as Record<string, unknown> | undefined)?.["openship.project"] ===
          excludeBareProjectId
      )
        continue;
      for (const port of managedProcessPorts(workload)) ports.add(port);
    }
    return [...ports];
  }

  async connectDocker() {
    for (let attempt = 0; ; attempt++) {
      await this.ensureBridge();
      try {
        return await openCloudDockerStream(await this.runtime(), this.workspaceId);
      } catch (error) {
        this.bridgePromise = undefined;
        // A cold restart can invalidate both a cached readiness result and the
        // SDK token. Retry the handshake once after probing again. The transport
        // has not forwarded any Docker request bytes until this promise resolves.
        if (attempt !== 0 || (error instanceof AppError && error.code === "CLOUD_COMMAND_EXIT_UNCONFIRMED")) throw error;
      }
    }
  }

  private ensureBridge(): Promise<void> {
    const initialize = async () => {
      const info = await this.client.workspaces.get(this.workspaceId);
      assertDockerWorkspaceOwner(info, this.options.namespace, this.workspaceId);
      assertCloudWorkspaceRunning(info);
      let runtime = await this.runtime();
      let refreshed = false;
      let lastProbe = "No health response";
      const ready = async (): Promise<boolean> => {
        let response: Response;
        try {
          response = await runtime
            .proxy(CLOUD_DOCKER_BRIDGE_PORT)
            .fetch("/health", { signal: AbortSignal.timeout(5000), redirect: "error" });
        } catch (error) {
          lastProbe =
            error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)
              ? "Bridge health request timed out"
              : "Bridge health network request failed";
          return false;
        }
        const requestId = response.headers.get("x-request-id");
        const reference =
          requestId && /^[a-zA-Z0-9_.:-]{1,128}$/.test(requestId) ? `; request ${requestId}` : "";
        lastProbe = `Bridge health HTTP ${response.status}${reference}`;
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          if (response.status === 401 && !refreshed) {
            refreshed = true;
            try {
              // Refresh only through this namespace's existing client. A revoked
              // namespace credential must still fail the control-plane check.
              runtime = await this.client.workspace(this.workspaceId).runtime({ force: true });
            } catch {
              throw new AppError(
                `The workspace Docker connection is unavailable: ${lastProbe}; workspace ${this.workspaceId}. Runtime credential refresh failed. Check namespace access.`,
                503,
                "CLOUD_DOCKER_PROXY_UNAVAILABLE",
              );
            }
            return ready();
          }
          // Installing or restarting Python cannot repair a missing platform
          // route or an authentication failure. Preserve the actual rejection.
          if ([401, 403, 404, 405, 501].includes(response.status)) {
            const accessRejected = [401, 403].includes(response.status);
            const hint = accessRejected
              ? "Oblien rejected access to the workspace proxy. Check runtime credentials and namespace access."
              : "Check that this workspace has a current Oblien runtime with the /proxy route and Docker bridge support.";
            throw new AppError(
              `The workspace Docker connection is unavailable: ${lastProbe}; workspace ${this.workspaceId}. ${hint}`,
              accessRejected ? 503 : 502,
              accessRejected ? "CLOUD_DOCKER_PROXY_UNAVAILABLE" : "CLOUD_RUNTIME_PROXY_UNAVAILABLE",
            );
          }
          return false;
        }
        try {
          if (await bridgeVersionMatches(response)) return true;
          lastProbe += "; unexpected bridge version";
        } catch {
          lastProbe += "; health response interrupted";
        }
        return false;
      };
      if (await ready()) return;
      await this.executor.exec("docker info --format '{{.ServerVersion}}'", { timeout: 60_000 });
      // Python is part of CLOUD_SERVER_IMAGE and also carries command streams.
      // A modified image missing it must fail at that boundary, not attempt to
      // bootstrap Python through the transport which already requires it.
      await this.executor.writeFile(BRIDGE_SCRIPT, CLOUD_DOCKER_BRIDGE_SOURCE, { mode: 0o700 });
      const workspace = this.client.workspace(this.workspaceId);
      const workload = (await workspace.workloads.list({ name: BRIDGE_WORKLOAD })).find(
        (item) => item.name === BRIDGE_WORKLOAD,
      );
      if (workload) {
        const state = String(workload.state ?? workload.status ?? "");
        if (["stopped", "failed", "exited"].includes(state)) {
          await workspace.workloads.start(workload.id);
        } else if (!(await ready())) {
          // Replacing the script does not update an already-running Python
          // process. Restart only the bridge, keeping Docker services running.
          await workspace.workloads.stop(workload.id);
          await workspace.workloads.start(workload.id);
        }
      } else {
        await workspace.workloads.create({
          name: BRIDGE_WORKLOAD,
          cmd: ["python3", BRIDGE_SCRIPT],
          restart_policy: "always",
          max_restarts: 0,
          labels: { "openship.workspace": this.workspaceId, "openship.role": "docker-api" },
        });
      }
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        if (await ready()) return;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      const failed = await workspace.workloads.list({ name: BRIDGE_WORKLOAD }).then(
        (items) => items.find((item) => item.name === BRIDGE_WORKLOAD),
        () => undefined,
      );
      const state = String(failed?.state ?? failed?.status ?? "unknown");
      const safeState = /^[a-z_]{1,32}$/.test(state) ? state : "unknown";
      throw new AppError(
        `The workspace Docker connection did not become ready: ${lastProbe}; Bridge state: ${safeState}; workspace ${this.workspaceId}. Check the workspace runtime proxy and the ${BRIDGE_WORKLOAD} workload.`,
        503,
        "CLOUD_DOCKER_BRIDGE_NOT_READY",
      );
    };
    return (this.bridgePromise ??= (
      this.options.bridgeLock ? this.options.bridgeLock.run(initialize) : initialize()
    ).catch((error) => {
      this.bridgePromise = undefined;
      throw error;
    }));
  }

  async resume(): Promise<void> {
    await this.options.beforeProvision?.();
    const ws = this.client.workspace(this.workspaceId);
    const data = await ws.get();
    assertDockerWorkspaceOwner(data, this.options.namespace, this.workspaceId);
    if (isDockerWorkspaceRunning(data)) return;
    const status = cloudWorkspaceStatus(data);
    if (status === "stopped") await ws.start();
    else if (status === "paused" || status === "suspended") await ws.resume();
    await waitForCloudDockerWorkspace(this.client, this.workspaceId, this.options.namespace);
    ws.invalidateRuntime();
    this.bridgePromise = undefined;
  }

  async dispose() {
    await this.executor.dispose();
  }
}
