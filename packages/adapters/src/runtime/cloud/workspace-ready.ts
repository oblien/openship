import { setTimeout as delay } from "node:timers/promises";
import type { Oblien, WorkspaceData } from "oblien";

export function assertDockerWorkspaceOwner(workspace: WorkspaceData, namespace: string): void {
  if (workspace.namespace !== namespace) throw new Error("Cloud workspace namespace does not match its project");
}

/** `status: active` describes the workspace record, even after a VM stop.
 * The provider's nested `info` contains the live VM lifecycle state. */
export function cloudWorkspaceStatus(workspace: { status: string; info?: unknown }): string {
  const info = workspace.info as { status?: string; is_running?: boolean } | undefined;
  if (info?.status) return info.status;
  if (typeof info?.is_running === "boolean") return info.is_running ? "running" : "stopped";
  return workspace.status;
}

export function isDockerWorkspaceRunning(workspace: { status: string; info?: unknown }): boolean {
  return cloudWorkspaceStatus(workspace) === "running";
}

/** Creation/start may outlive a request. Waiting never creates a replacement disk. */
export async function waitForCloudDockerWorkspace(
  client: Oblien, workspaceId: string, namespace: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<WorkspaceData> {
  const deadline = Date.now() + (options.timeoutMs ?? 600_000);
  while (true) {
    options.signal?.throwIfAborted();
    const workspace = await client.workspaces.get(workspaceId);
    assertDockerWorkspaceOwner(workspace, namespace);
    const provisioning = workspace.provisioning as { state?: string; error?: unknown } | undefined;
    if (provisioning?.state === "failed" || ["error", "failed"].includes(cloudWorkspaceStatus(workspace))) {
      throw new Error("Oblien could not start the Docker workspace. Its existing disk has been retained; retry provisioning in Oblien.");
    }
    if (isDockerWorkspaceRunning(workspace) &&
        (!provisioning || provisioning.state === "ready") && workspace.ready !== false) return workspace;
    if (Date.now() >= deadline) throw new Error("Docker workspace is still starting. Retry the deployment to reconnect to the same workspace.");
    await delay(1000, undefined, { signal: options.signal });
  }
}
