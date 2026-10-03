import { randomUUID } from "node:crypto";
import type { Runtime } from "oblien";
import { AppError, type ManagedCommandRef } from "@repo/core";
import { CLOUD_DOCKER_BRIDGE_PORT } from "./docker-bridge-source";
import { currentManagedCommandTracking } from "./command-tracking";
import { dockerWebSocketStream } from "./docker-transport";

function requestId(marker: string) {
  const match = /^openship-exec-([a-f0-9-]{36}):$/.exec(marker);
  if (!match) throw new Error("Invalid Docker request recovery identity");
  return match[1]!;
}

/** The guest retains the original Docker response even if its controller dies.
 * A bridge crash is uncertainty, not permission to replay a daemon mutation. */
export async function recoverCloudDockerRequest(runtime: Runtime, command: ManagedCommandRef) {
  const id = requestId(command.marker);
  const deadline = Date.now() + 15_000;
  for (;;) {
    let state: unknown;
    try {
      const response = await runtime.proxy(CLOUD_DOCKER_BRIDGE_PORT).fetch(`/recover/${id}`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error("Docker recovery is unavailable");
      const result = await response.json() as { id?: unknown; complete?: unknown; state?: unknown };
      if (result.id !== id) throw new Error("Docker recovery identity changed");
      if (result.complete === true) return;
      state = result.state;
    } catch {
      throw new AppError(
        "Could not confirm the earlier Docker request finished. Retry this operation when the managed server is reachable.",
        503, "CLOUD_COMMAND_EXIT_UNCONFIRMED",
      );
    }
    if (state !== "pending")
      throw new AppError(
        "Docker lost the result of an earlier operation. Restart the managed server from the provider console, then retry the interrupted operation.",
        503, "CLOUD_COMMAND_EXIT_UNCONFIRMED",
      );
    if (Date.now() >= deadline)
      throw new AppError(
        "The earlier Docker request is still finishing on the server. Wait, then retry this operation.",
        503, "CLOUD_COMMAND_EXIT_UNCONFIRMED",
      );
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

/** Persist before opening the request tunnel; completion belongs to the guest
 * response, never to a local socket timeout or a closed WebSocket. */
export async function openCloudDockerStream(runtime: Runtime, workspaceId: string) {
  const tracking = currentManagedCommandTracking();
  if (!tracking)
    return dockerWebSocketStream(runtime.proxy(CLOUD_DOCKER_BRIDGE_PORT).ws("/docker"));

  const id = randomUUID();
  const command: ManagedCommandRef = { workspaceId, marker: `openship-exec-${id}:`, kind: "docker" };
  await tracking.record(command);
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const completion = new Promise<void>((done, failed) => { resolve = done; reject = failed; });
  tracking.defer(completion);
  let finishing: Promise<void> | undefined;
  const finish = (confirmed: boolean) => finishing ??= (async () => {
    if (!confirmed) await recoverCloudDockerRequest(runtime, command);
    await tracking.complete(command.marker);
  })().then(resolve, reject);

  try {
    const stream = await dockerWebSocketStream(
      runtime.proxy(CLOUD_DOCKER_BRIDGE_PORT).ws(`/docker/${id}`),
      () => { void finish(true); },
    );
    stream.once("close", () => { void finish(false); });
    if (stream.destroyed) void finish(false);
    return stream;
  } catch (error) {
    await finish(false);
    await completion;
    throw error;
  }
}
