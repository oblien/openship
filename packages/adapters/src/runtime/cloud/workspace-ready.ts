import { setTimeout as delay } from "node:timers/promises";
import type { Oblien, WorkspaceData } from "oblien";
import { AppError } from "@repo/core";

export function assertDockerWorkspaceOwner(workspace: WorkspaceData, namespace: string, workspaceId: string): void {
  if (workspace.namespace !== namespace || workspace.id !== workspaceId)
    throw new AppError("Cloud workspace identity does not match its server", 502, "CLOUD_SERVER_IDENTITY_MISMATCH");
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

export function assertCloudWorkspaceRunning(workspace: WorkspaceData): void {
  const state = cloudWorkspaceStatus(workspace);
  if (state === "running") return;
  if (["stopped", "paused", "suspended"].includes(state))
    throw new AppError("The managed server is stopped. Start it to read its applications.", 409, "CLOUD_WORKSPACE_STOPPED");
  if (["starting", "creating", "provisioning", "resuming", "stopping", "pausing"].includes(state))
    throw new AppError("The managed server is changing state. Wait for it to finish, then retry.", 409, "CLOUD_WORKSPACE_STARTING");
  throw new AppError("The managed server is unavailable. Check its status and retry.", 503, "CLOUD_SERVER_STATE_UNAVAILABLE");
}

/** Stop acknowledgements can precede the VM transition. Never report success
 * until the provider confirms the same server is stopped. */
export async function waitForCloudWorkspaceStopped(client: Oblien, workspaceId: string, namespace: string) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const workspace = await client.workspaces.get(workspaceId);
    assertDockerWorkspaceOwner(workspace, namespace, workspaceId);
    if (["stopped", "paused", "suspended"].includes(cloudWorkspaceStatus(workspace))) return;
    if (Date.now() >= deadline) throw new Error("The managed server has not returned to its stopped state");
    await delay(500);
  }
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
    assertDockerWorkspaceOwner(workspace, namespace, workspaceId);
    const provisioning = workspace.provisioning as { state?: string; error?: unknown } | undefined;
    if (provisioning?.state === "failed" || ["error", "failed"].includes(cloudWorkspaceStatus(workspace))) {
      throw new Error("Oblien could not start the Docker workspace. Its existing disk has been retained. Retry the deployment; contact Openship support if it still cannot start.");
    }
    if (isDockerWorkspaceRunning(workspace) &&
        (!provisioning || provisioning.state === "ready") && workspace.ready !== false) return workspace;
    if (Date.now() >= deadline) throw new Error("Docker workspace is still starting. Retry the deployment to reconnect to the same workspace.");
    await delay(1000, undefined, { signal: options.signal });
  }
}
