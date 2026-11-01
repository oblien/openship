import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import {
  AppError,
  handoffInstance,
  instanceOrigin,
  type HandoffSource,
  type HandoffTarget,
  type InstanceHandoffCode,
} from "@repo/core";
import { db, eq, schema } from "@repo/db";
import * as peer from "./handoff-peer";

/** Redirects never receive instance credentials. A peer is one fixed origin,
 * authenticated with a revocable handoff capability, not a global admin key. */
export async function peerRequest<T>(
  code: InstanceHandoffCode,
  action: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(
    `${instanceOrigin(code.origin)}/api/system/instance/peer/${code.id}/${action}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${code.token}` },
      body: JSON.stringify(body ?? {}),
      redirect: "error",
      signal: AbortSignal.timeout(30 * 60_000),
    },
  );
  if (!response.ok) {
    const error = (await response.json().catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "api/modules/system/instance/handoff-client"); return ({}); })) as { error?: string; code?: string };
    throw new AppError(
      error.error ?? `The other instance returned HTTP ${response.status}.`,
      502,
      error.code ?? "INSTANCE_PEER_UNAVAILABLE",
    );
  }
  return (await response.json()) as T;
}

function remoteSource(code: InstanceHandoffCode): HandoffSource {
  return {
    freeze: () => peerRequest(code, "freeze"),
    chunk: async (index) => {
      const response = await fetch(
        `${code.origin}/api/system/instance/peer/${code.id}/chunks/${index}`,
        {
          headers: { authorization: `Bearer ${code.token}` },
          redirect: "error",
          signal: AbortSignal.timeout(120_000),
        },
      );
      if (!response.ok)
        throw new AppError("A snapshot chunk could not be downloaded. Resume to retry.", 502);
      const reader = response.body!.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 8_000_064)
            throw new AppError("The other instance returned an oversized chunk.", 502);
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      return Buffer.concat(chunks);
    },
    retire: (manifest) => peerRequest(code, "retire", { manifest }),
    complete: (connection) => peerRequest(code, "complete", { connection }),
  };
}
function remoteTarget(code: InstanceHandoffCode): HandoffTarget {
  return {
    stage: (manifest) => peerRequest(code, "stage", { manifest }),
    chunk: async (index, bytes) => {
      const response = await fetch(
        `${code.origin}/api/system/instance/peer/${code.id}/chunks/${index}`,
        {
          method: "PUT",
          headers: {
            "content-type": "application/octet-stream",
            authorization: `Bearer ${code.token}`,
          },
          body: Buffer.from(bytes),
          redirect: "error",
          signal: AbortSignal.timeout(120_000),
        },
      );
      if (!response.ok)
        throw new AppError("A snapshot chunk could not be uploaded. Resume to retry.", 502);
    },
    prepare: () => peerRequest(code, "prepare"),
    activate: (proof) => peerRequest(code, "activate", { proof }),
  };
}

const running = new Map<string, Promise<void>>();
/** Local coordinator works in both directions. Pulling is essential: an ordinary
 * Desktop is behind NAT and must never need an inbound public listener. */
export function resumeHandoff(id: string, localOrigin: string): Promise<void> {
  const existing = running.get(id);
  if (existing) return existing;
  const work = (async () => {
    const record = await peer.journal(id),
      remote = await peer.savedPeer(id);
    const local = await peer.localPeerCode(id, localOrigin);
    await peerRequest(remote, "bind", { peer: local });
    const source: HandoffSource =
      record.direction === "source"
        ? {
            freeze: () => peer.freezeSource(id),
            chunk: (index) => peer.getSourceChunk(id, index),
            retire: (manifest) => peer.retireSource(id, manifest),
            complete: (connection) => peer.completeSource(id, connection),
          }
        : remoteSource(remote);
    const target: HandoffTarget =
      record.direction === "target"
        ? {
            stage: (manifest) => peer.stageTarget(id, manifest),
            chunk: (index, bytes) => peer.putTargetChunk(id, index, bytes),
            prepare: () => peer.prepareTarget(id),
            activate: (proof) => peer.activateTarget(id, proof, localOrigin),
          }
        : remoteTarget(remote);
    await db
      .update(schema.instanceHandoff)
      .set({ error: null })
      .where(eq(schema.instanceHandoff.id, id));
    await handoffInstance(source, target);
  })()
    .catch(async (error) => {
      observeCaughtError(error, "api/modules/system/instance/handoff-client");
      // This records the failure, never unlocks either controller. Reconnection
      // and process restart resume the same journal and snapshot.
      await db
        .update(schema.instanceHandoff)
        .set({
          error:
            error instanceof Error ? error.message : "The move was interrupted. Resume to retry.",
        })
        .where(eq(schema.instanceHandoff.id, id));
    })
    .finally(() => {
      running.delete(id);
    });
  running.set(id, work);
  return work;
}

export const handoffRunning = (id: string) => running.has(id);

export async function cancelHandoff(id: string): Promise<void> {
  if (handoffRunning(id))
    throw new AppError(
      "The current step is still running. Wait for it to finish before cancelling.",
      409,
    );
  const record = await peer.journal(id);
  const remote = record.peerId ? await peer.savedPeer(id) : null;
  if (record.direction === "source") {
    const proof = await peer.abortHandoff(id);
    if (remote) await peerRequest(remote, "abort", { proof });
  } else {
    const proof = remote ? await peerRequest<string>(remote, "abort") : undefined;
    await peer.abortHandoff(id, proof);
  }
}
