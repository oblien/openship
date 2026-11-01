import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { db, eq, schema, withAdvisoryLock, type DatabaseTransaction } from "@repo/db";
import {
  AppError,
  instanceOrigin,
  instanceEnvironment,
  INSTANCE_ENVIRONMENT_KEYS,
  type ControllerRole,
  type HandoffManifest,
  type InstanceConnection,
  type InstanceHandoffCode,
} from "@repo/core";
import { env } from "@repo/platform/engine/config/env";
import {
  encrypt,
  decrypt,
  encryptBytesWithKey,
  decryptBytesWithKey,
} from "@repo/platform/engine/lib/encryption";
import { readApiVersion } from "@repo/platform/engine/lib/release-resolver";
import { prepareInstanceExport } from "../data-transfer/export.service";
import { importPreparedInstance } from "../data-transfer/import.service";
import { jsonByteChunks } from "../data-transfer/json-chunks";
import {
  MAX_TRANSFER_BYTES,
  MAX_TRANSFER_CHUNKS,
  TRANSFER_CHUNK_BYTES,
  TransferStoreError,
  readChunk,
  sha256Hex,
  stageChunk,
  type TransferSessionRow,
} from "../data-transfer/chunk-store";
import { readStagedJson } from "../data-transfer/staged-payload";
import type { DataTransferFile, SecretBundle } from "../data-transfer/types";
import {
  controllerState,
  setControllerRole,
  startController,
  stopController,
  restartController,
} from "./controller-state";
import {
  assertHandoffAccount,
  assertPortableInstance,
  prepareHandoffSnapshot,
  type HostMapping,
} from "./portability";
import { resumeControllerSockets } from "../../../lib/ws";
import { deviceConnection } from "./device-session";

const OFFER_MS = 10 * 60_000;
const JOURNAL_MS = 30 * 24 * 60 * 60_000;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
const fail = (message: string, code = "INSTANCE_HANDOFF_CONFLICT") =>
  new AppError(message, 409, code);
const lock = <T>(work: () => Promise<T>): Promise<T> => withAdvisoryLock("instance-handoff", work);
type Journal = typeof schema.instanceHandoff.$inferSelect;
type Secrets = {
  key: string;
  proof: string;
  cancellationProof: string;
  token: string;
  mapping?: HostMapping;
  peer?: InstanceHandoffCode;
  previous: {
    role: ControllerRole;
    connection: string | null;
    environment: string | null;
    desktopUserId: string | null;
  };
};

export const handoffCodeSchema = z.object({
  protocol: z.literal(1),
  id: z.string().uuid(),
  origin: z.string().transform(instanceOrigin),
  installationId: z.string().uuid(),
  direction: z.enum(["source", "target"]),
  token: z.string().regex(/^[\w-]{43}$/),
  key: z.string().regex(/^[\w-]{43}$/),
});
export const manifestSchema = z.object({
  protocol: z.literal(1),
  id: z.string().uuid(),
  sourceId: z.string().uuid(),
  targetId: z.string().uuid(),
  version: z.string().max(100),
  ownerUserId: z.string().min(1).max(200),
  totalBytes: z.number().int().min(1).max(MAX_TRANSFER_BYTES),
  totalChunks: z.number().int().min(1).max(MAX_TRANSFER_CHUNKS),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  retirementHash: z.string().regex(/^[a-f0-9]{64}$/),
  cancellationHash: z.string().regex(/^[a-f0-9]{64}$/),
});
const sameManifest = (a: HandoffManifest, b: HandoffManifest) =>
  JSON.stringify(manifestSchema.parse(a)) === JSON.stringify(manifestSchema.parse(b));

export function decodeHandoffCode(value: string): InstanceHandoffCode {
  if (value.length > 4_000) throw fail("This connection code is invalid.");
  try {
    return handoffCodeSchema.parse(
      JSON.parse(Buffer.from(value.trim(), "base64url").toString("utf8")),
    );
  } catch (diagnosticFailure) {
    observeCaughtError(diagnosticFailure, "api/modules/system/instance/handoff-peer");
    throw fail("This connection code is invalid. Create a new code on the other instance.");
  }
}
export const encodeHandoffCode = (value: InstanceHandoffCode) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

export async function journal(id: string): Promise<Journal> {
  const [row] = await db
    .select()
    .from(schema.instanceHandoff)
    .where(eq(schema.instanceHandoff.id, id));
  if (!row) throw new AppError("This move could not be found.", 404, "INSTANCE_HANDOFF_NOT_FOUND");
  return row;
}
const keys = (row: Journal): Secrets => JSON.parse(decrypt(row.secrets));
const chunkKey = (row: Journal, index: number) =>
  createHmac("sha256", Buffer.from(keys(row).key, "base64url"))
    .update(`openship:instance:${row.id}:${index}`)
    .digest();

export async function authenticatePeer(id: string, token: string, abort = false): Promise<Journal> {
  if (!/^[\w-]{43}$/.test(token)) throw new AppError("Invalid handoff authorization.", 401);
  const row = await journal(id);
  if (
    !timingSafeEqual(Buffer.from(row.tokenHash, "hex"), Buffer.from(digest(token), "hex")) ||
    (!abort && (row.status === "aborted" || row.expiresAt.getTime() < Date.now()))
  ) {
    throw new AppError(
      "This handoff code has expired or was revoked.",
      401,
      "INSTANCE_HANDOFF_UNAUTHORIZED",
    );
  }
  return row;
}

async function currentJournal(id: string): Promise<Journal> {
  const row = await journal(id);
  if ((await controllerState()).handoffId !== id || row.status === "aborted")
    throw fail("This move has been superseded or cancelled.");
  return row;
}

async function staging(id: string): Promise<TransferSessionRow> {
  const expiry = new Date(Date.now() + JOURNAL_MS);
  await db
    .insert(schema.dataTransferSession)
    .values({
      id,
      kind: "file",
      status: "uploading",
      ownerUserId: `instance:${id}`,
      expiresAt: expiry,
      maxExpiresAt: expiry,
    })
    .onConflictDoNothing();
  const [row] = await db
    .update(schema.dataTransferSession)
    .set({ expiresAt: expiry, maxExpiresAt: expiry })
    .where(eq(schema.dataTransferSession.id, id))
    .returning();
  return row!;
}

export async function createHandoffOffer(input: {
  ownerUserId: string;
  direction: "source" | "target";
  origin: string;
  /** Internal coordinator shares the receiving peer's id/key; never caller-selected by a public receiver. */
  peer?: InstanceHandoffCode;
  mapping?: HostMapping;
}): Promise<InstanceHandoffCode> {
  if (env.CLOUD_MODE)
    throw new AppError("Cloud accounts cannot move the shared SaaS instance.", 403);
  return lock(async () => {
    const state = await controllerState();
    const id = input.peer?.id ?? randomUUID();
    const [pending] = await db
      .select()
      .from(schema.instanceHandoff)
      .where(eq(schema.instanceHandoff.id, id));
    if (pending) {
      if (
        state.handoffId !== id ||
        pending.ownerUserId !== input.ownerUserId ||
        pending.direction !== input.direction ||
        pending.status === "aborted"
      )
        throw fail("This move cannot be reused.");
      const saved = keys(pending);
      return {
        protocol: 1,
        id,
        origin: instanceOrigin(input.origin),
        installationId: state.installationId,
        direction: input.direction,
        token: saved.token,
        key: saved.key,
      };
    }
    if (
      state.role !== "active" &&
      !(["retired", "connected"].includes(state.role) && input.direction === "target") &&
      !(state.role === "receiving" && !state.handoffId && input.direction === "target")
    ) {
      throw fail("Finish or cancel the current move before starting another.");
    }
    // A separate offer cannot supersede a capability that still controls this instance.
    if (state.handoffId) {
      const previous = await journal(state.handoffId);
      if (!["complete", "aborted"].includes(previous.status))
        throw fail("Finish or cancel the current move first.");
    }
    const token = secret();
    const material: Secrets = {
      token,
      key: input.peer?.key ?? secret(),
      proof: secret(),
      cancellationProof: secret(),
      mapping: input.mapping,
      previous: {
        role: state.role,
        connection: state.connection,
        environment: state.environment,
        desktopUserId: state.desktopUserId,
      },
    };
    await db.transaction(async (tx) => {
      await tx.insert(schema.instanceHandoff).values({
        id,
        direction: input.direction,
        ownerUserId: input.ownerUserId,
        tokenHash: digest(token),
        secrets: encrypt(JSON.stringify(material)),
        peerOrigin: input.peer?.origin,
        peerId: input.peer?.installationId,
        expiresAt: new Date(Date.now() + OFFER_MS),
      });
      // Receiving is destructive only after the user confirms a move. Offering
      // a code reserves the controller; source work continues until freeze().
      await tx
        .update(schema.instanceController)
        .set({ handoffId: id })
        .where(eq(schema.instanceController.id, "local"));
    });
    return {
      protocol: 1,
      id,
      origin: instanceOrigin(input.origin),
      installationId: state.installationId,
      direction: input.direction,
      token,
      key: material.key,
    };
  });
}

export async function bindPeer(id: string, peer: InstanceHandoffCode): Promise<void> {
  await lock(async () => {
    const row = await currentJournal(id);
    if (row.peerId && row.peerId !== peer.installationId)
      throw fail("This move is already bound to another instance.");
    if (
      peer.id !== id ||
      peer.installationId === (await controllerState()).installationId ||
      peer.key !== keys(row).key ||
      row.direction === peer.direction
    )
      throw fail("The two ends of this move do not match.");
    if (row.peerOrigin && row.peerOrigin !== peer.origin)
      throw fail("This move is already bound to another API address.");
    await db
      .update(schema.instanceHandoff)
      .set({
        peerId: peer.installationId,
        peerOrigin: peer.origin,
        expiresAt: new Date(Date.now() + JOURNAL_MS),
        secrets: encrypt(JSON.stringify({ ...keys(row), peer })),
      })
      .where(eq(schema.instanceHandoff.id, id));
  });
}

export async function freezeSource(id: string): Promise<HandoffManifest> {
  return lock(async () => {
    const row = await currentJournal(id);
    if (row.direction !== "source" || !row.peerId)
      throw fail("Choose the receiving instance first.");
    if (row.manifest) return row.manifest;
    const state = await controllerState();
    if (state.handoffId !== id || !["active", "quiescing", "frozen"].includes(state.role))
      throw fail("This controller cannot export this move.");
    await assertPortableInstance(keys(row).mapping);
    await assertHandoffAccount(row.ownerUserId);
    await setControllerRole("quiescing", id);
    await stopController();
    // A settings request admitted just before the fence may have changed a
    // host connection. Validate the settled database we are about to export.
    await assertPortableInstance(keys(row).mapping);
    await assertHandoffAccount(row.ownerUserId);
    const payload = {
      ...(await prepareInstanceExport()),
      environment: instanceEnvironment(process.env),
    };
    await prepareHandoffSnapshot(payload, keys(row).mapping, state.projectId);
    // A crashed partial snapshot is never mixed with a newer export.
    await db.delete(schema.dataTransferChunk).where(eq(schema.dataTransferChunk.sessionId, id));
    const session = await staging(id);
    let totalBytes = 0,
      totalChunks = 0;
    const hash = createHash("sha256");
    for (const bytes of jsonByteChunks(payload, TRANSFER_CHUNK_BYTES)) {
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_TRANSFER_BYTES)
        throw fail("The instance archive exceeds the transfer limit. Export old logs and retry.");
      hash.update(bytes);
      const encrypted = encryptBytesWithKey(chunkKey(row, totalChunks), bytes);
      await stageChunk({
        session,
        index: totalChunks++,
        bytes: encrypted,
        sha256: sha256Hex(encrypted),
        leaseUntil: session.maxExpiresAt,
      });
    }
    const manifest: HandoffManifest = {
      protocol: 1,
      id,
      sourceId: state.installationId,
      targetId: row.peerId,
      version: readApiVersion(),
      totalBytes,
      totalChunks,
      sha256: hash.digest("hex"),
      retirementHash: digest(keys(row).proof),
      cancellationHash: digest(keys(row).cancellationProof),
      ownerUserId: row.ownerUserId,
    };
    await db.transaction(async (tx) => {
      await tx
        .update(schema.instanceHandoff)
        .set({ manifest, status: "frozen", expiresAt: new Date(Date.now() + JOURNAL_MS) })
        .where(eq(schema.instanceHandoff.id, id));
      await setControllerRole("frozen", id, tx);
    });
    return manifest;
  });
}

export async function getSourceChunk(id: string, index: number): Promise<Uint8Array> {
  const row = await currentJournal(id);
  if (row.direction !== "source" || !row.manifest || index < 0 || index >= row.manifest.totalChunks)
    throw fail("This snapshot chunk is unavailable.");
  const bytes = await readChunk(id, index);
  if (!bytes)
    throw fail("The saved snapshot is incomplete. Resume the move on its source instance.");
  return bytes;
}

export async function stageTarget(id: string, input: HandoffManifest): Promise<void> {
  const manifest = manifestSchema.parse(input);
  await lock(async () => {
    const row = await currentJournal(id),
      state = await controllerState();
    if (
      row.direction !== "target" ||
      id !== manifest.id ||
      manifest.targetId !== state.installationId ||
      manifest.sourceId === state.installationId ||
      (row.peerId && row.peerId !== manifest.sourceId)
    )
      throw fail("The snapshot belongs to another instance.");
    if (manifest.version !== readApiVersion())
      throw fail(
        "Install the same Openship version on both instances before moving.",
        "INSTANCE_VERSION_MISMATCH",
      );
    if (row.manifest) {
      if (!sameManifest(row.manifest, manifest))
        throw fail("This move already has a different snapshot.");
      return;
    }
    if (state.handoffId !== id) throw fail("This receiver is reserved for another move.");
    await setControllerRole("quiescing", id);
    await stopController();
    // Preserve a recovery archive of the destination BEFORE an overwrite. The
    // key remains local; no download or user-managed password is required.
    const backup = await prepareInstanceExport();
    const recoveryId = `recovery:${id}`;
    const recovery = await staging(recoveryId);
    await db
      .delete(schema.dataTransferChunk)
      .where(eq(schema.dataTransferChunk.sessionId, recoveryId));
    let index = 0,
      totalBytes = 0;
    const hash = createHash("sha256");
    for (const bytes of jsonByteChunks(backup, TRANSFER_CHUNK_BYTES)) {
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_TRANSFER_BYTES)
        throw fail("The receiver’s recovery archive exceeds the transfer limit.");
      hash.update(bytes);
      const encrypted = encryptBytesWithKey(chunkKey(row, index), bytes);
      await stageChunk({
        session: recovery,
        index: index++,
        bytes: encrypted,
        sha256: sha256Hex(encrypted),
        leaseUntil: recovery.maxExpiresAt,
      });
    }
    await staging(id);
    await db.transaction(async (tx) => {
      await tx
        .update(schema.instanceHandoff)
        .set({
          manifest,
          recovery: { totalBytes, totalChunks: index, sha256: hash.digest("hex") },
          status: "copying",
          peerId: manifest.sourceId,
        })
        .where(eq(schema.instanceHandoff.id, id));
      await setControllerRole("receiving", id, tx);
    });
  });
}

export async function putTargetChunk(id: string, index: number, bytes: Uint8Array): Promise<void> {
  await lock(async () => {
    const row = await currentJournal(id);
    if (
      row.direction !== "target" ||
      !row.manifest ||
      index < 0 ||
      index >= row.manifest.totalChunks
    )
      throw fail("This receiver is not accepting chunks.");
    if (row.status === "prepared" || row.status === "complete") return;
    if (row.status !== "copying") throw fail("This receiver is not accepting chunks.");
    // Authenticate every bounded chunk before saving it. The derived key binds
    // its transfer id and ordinal, so reordered/cross-transfer chunks fail.
    try {
      decryptBytesWithKey(chunkKey(row, index), bytes);
    } catch (diagnosticFailure) {
      observeCaughtError(diagnosticFailure, "api/modules/system/instance/handoff-peer");
      throw new AppError(
        "This snapshot chunk failed verification. Resume the move to resend it.",
        400,
        "INSTANCE_CHUNK_INVALID",
      );
    }
    const session = await staging(id);
    await stageChunk({
      session,
      index,
      bytes,
      sha256: sha256Hex(bytes),
      leaseUntil: session.maxExpiresAt,
    });
  });
}

export async function prepareTarget(id: string): Promise<void> {
  await lock(async () => {
    const row = await currentJournal(id);
    if (row.direction !== "target" || !row.manifest)
      throw fail("No complete snapshot has been received.");
    if (row.status === "prepared" || row.status === "complete") return;
    if (row.status !== "copying") throw fail("This receiver cannot import a snapshot.");
    const payload = (await readStagedJson(await staging(id), row.manifest, (bytes, index) =>
      decryptBytesWithKey(chunkKey(row, index), bytes),
    ).catch((error) => {
      if (error instanceof TransferStoreError) throw fail(error.message, `INSTANCE_${error.code}`);
      throw error;
    })) as {
      file: DataTransferFile;
      secrets: SecretBundle | null;
      environment?: Record<string, string>;
    };
    const state = await controllerState();
    await importPreparedInstance({
      file: payload.file,
      secrets: payload.secrets,
      mode: "wipe",
      onBeforeCommit: async (tx) => {
        const [owner] = await tx
          .select()
          .from(schema.user)
          .where(eq(schema.user.id, row.manifest!.ownerUserId));
        if (owner?.role !== "admin")
          throw fail("The snapshot does not contain its authorized administrator.");
        await tx.delete(schema.session); // no copied browser/device sessions
        if (state.projectId) {
          // Reuse the existing control-plane guards. This is the receiver's
          // installation binding, never a project id supplied by the sender.
          await tx
            .update(schema.project)
            .set({ appTemplateId: "openship" })
            .where(eq(schema.project.id, state.projectId));
        }
        await tx
          .update(schema.instanceController)
          .set({
            environment: encrypt(JSON.stringify(instanceEnvironment(payload.environment ?? {}))),
          })
          .where(eq(schema.instanceController.id, "local"));
        await tx
          .update(schema.instanceHandoff)
          .set({ status: "prepared" })
          .where(eq(schema.instanceHandoff.id, id));
        await setControllerRole("prepared", id, tx, null);
      },
    });
  });
}

export async function retireSource(id: string, input: HandoffManifest): Promise<string> {
  return lock(async () => {
    const row = await journal(id);
    if ((await controllerState()).handoffId !== id) throw fail("This move has been superseded.");
    if (
      row.direction !== "source" ||
      !row.manifest ||
      !sameManifest(row.manifest, input) ||
      !["frozen", "retired", "complete"].includes(row.status)
    )
      throw fail("This source is not ready to relinquish control.");
    if (row.status === "frozen")
      await db.transaction(async (tx) => {
        await tx
          .update(schema.instanceHandoff)
          .set({ status: "retired" })
          .where(eq(schema.instanceHandoff.id, id));
        await setControllerRole("retired", id, tx);
      });
    return keys(row).proof;
  });
}

export async function activateTarget(
  id: string,
  proof: string,
  origin: string,
): Promise<InstanceConnection> {
  const connection = await lock(async () => {
    const row = await journal(id);
    if ((await controllerState()).handoffId !== id) throw fail("This move has been superseded.");
    if (
      row.direction !== "target" ||
      !row.manifest ||
      digest(proof) !== row.manifest.retirementHash
    )
      throw fail("The source has not relinquished control.");
    if (row.status === "complete" && row.result)
      return JSON.parse(decrypt(row.result)) as InstanceConnection;
    if (row.status !== "prepared" || (await controllerState()).role !== "prepared")
      throw fail("Verify the received snapshot before activating this instance.");
    const sessionToken = secret();
    const connection = await deviceConnection(origin, row.manifest.targetId, sessionToken);
    await db.transaction(async (tx) => {
      const [membership] = await tx
        .select()
        .from(schema.member)
        .where(eq(schema.member.userId, row.manifest!.ownerUserId))
        .limit(1);
      if (!membership) throw fail("The instance administrator has no workspace.");
      await tx.insert(schema.session).values({
        id: randomUUID(),
        token: sessionToken,
        userId: row.manifest!.ownerUserId,
        activeOrganizationId: membership.organizationId,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
        userAgent: "Openship Desktop (paired instance)",
      });
      await tx
        .update(schema.instanceHandoff)
        .set({ status: "complete", result: encrypt(JSON.stringify(connection)) })
        .where(eq(schema.instanceHandoff.id, id));
      if (env.DEPLOY_MODE === "desktop")
        await tx
          .update(schema.instanceController)
          .set({ desktopUserId: row.manifest!.ownerUserId })
          .where(eq(schema.instanceController.id, "local"));
      await setControllerRole("active", id, tx, null);
    });
    return connection;
  });
  const state = await controllerState();
  const environment = state.environment
    ? instanceEnvironment(JSON.parse(decrypt(state.environment)))
    : {};
  if (
    state.environment &&
    INSTANCE_ENVIRONMENT_KEYS.some((key) => (environment[key] ?? "") !== (process.env[key] ?? ""))
  )
    restartController();
  else await startController();
  return connection;
}

export async function completeSource(id: string, connection: InstanceConnection): Promise<void> {
  await lock(async () => {
    const row = await journal(id);
    if ((await controllerState()).handoffId !== id) throw fail("This move has been superseded.");
    if (
      row.direction !== "source" ||
      !["retired", "complete"].includes(row.status) ||
      connection.installationId !== row.peerId ||
      instanceOrigin(connection.origin) !== row.peerOrigin
    )
      throw fail("The active instance does not match this move.");
    await db.transaction(async (tx) => {
      await tx
        .update(schema.instanceHandoff)
        .set({ status: "complete", result: encrypt(JSON.stringify(connection)) })
        .where(eq(schema.instanceHandoff.id, id));
      await setControllerRole("retired", id, tx, connection);
    });
  });
  if (env.DEPLOY_MODE === "desktop") resumeControllerSockets();
}

export async function savedPeer(id: string): Promise<InstanceHandoffCode> {
  const peer = keys(await journal(id)).peer;
  if (!peer) throw fail("Connect the other instance before resuming this move.");
  return peer;
}

/** A Desktop which pulled its remote instance back keeps that device's prior
 * connection encrypted in its local journal, for an explicit move back there. */
export async function previousInstanceConnection(): Promise<InstanceConnection | null> {
  const state = await controllerState();
  if (env.DEPLOY_MODE !== "desktop" || state.role !== "active" || !state.handoffId) return null;
  const row = await journal(state.handoffId);
  if (row.direction !== "target" || row.status !== "complete") return null;
  const connection = keys(row).previous.connection;
  return connection ? (JSON.parse(decrypt(connection)) as InstanceConnection) : null;
}

export async function localPeerCode(id: string, origin: string): Promise<InstanceHandoffCode> {
  const row = await journal(id),
    material = keys(row);
  return {
    protocol: 1,
    id,
    origin: instanceOrigin(origin),
    installationId: (await controllerState()).installationId,
    direction: row.direction,
    token: material.token,
    key: material.key,
  };
}

/** Abort the SOURCE first. Revoking its proof while still frozen makes it
 * impossible for a prepared receiver to activate later, even after a timeout.
 * Once a proof has been revealed, only resume or a fresh reverse handoff is safe. */
export async function abortHandoff(id: string, cancellationProof?: string): Promise<string | null> {
  let shouldStart = false;
  const receipt = await lock(async () => {
    const row = await journal(id);
    if (row.status === "aborted")
      return row.direction === "source" ? keys(row).cancellationProof : null;
    await currentJournal(id);
    if (["retired", "complete"].includes(row.status))
      throw fail(
        "Control has already moved. Resume the connection, then move back from the active instance.",
      );
    if (
      row.direction === "target" &&
      row.manifest &&
      (!cancellationProof || digest(cancellationProof) !== row.manifest.cancellationHash)
    ) {
      throw fail(
        "Cancel on the source instance first. Its confirmation is required before restoring this receiver.",
      );
    }
    const previous = keys(row).previous;
    const restoreState = async (tx: DatabaseTransaction) => {
      await tx
        .update(schema.instanceHandoff)
        .set({ status: "aborted", error: null })
        .where(eq(schema.instanceHandoff.id, id));
      await setControllerRole(previous.role, id, tx);
      await tx
        .update(schema.instanceController)
        .set({
          connection: previous.connection,
          environment: previous.environment,
          desktopUserId: previous.desktopUserId,
        })
        .where(eq(schema.instanceController.id, "local"));
    };
    if (row.direction === "target" && row.status === "prepared") {
      if (!row.recovery)
        throw fail(
          "The receiver’s recovery snapshot is missing. Contact support before changing this instance.",
        );
      const payload = (await readStagedJson(
        await staging(`recovery:${id}`),
        row.recovery,
        (bytes, index) => decryptBytesWithKey(chunkKey(row, index), bytes),
      )) as { file: DataTransferFile; secrets: SecretBundle | null };
      await importPreparedInstance({ ...payload, mode: "wipe", onBeforeCommit: restoreState });
    } else await db.transaction(restoreState);
    shouldStart = previous.role === "active";
    return row.direction === "source" ? keys(row).cancellationProof : null;
  });
  if (shouldStart) await startController();
  else if (env.DEPLOY_MODE === "desktop") resumeControllerSockets();
  return receipt;
}
