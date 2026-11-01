import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { db, eq, and, gt, schema, withAdvisoryLock } from "@repo/db";
import { AppError, instanceOrigin, type InstanceConnection } from "@repo/core";
import { env } from "@repo/platform/engine/config/env";
import {
  controllerState,
  controllerConnection,
  setControllerRole,
  startController,
  stopController,
} from "./controller-state";
import * as peer from "./handoff-peer";
import { resumeHandoff } from "./handoff-client";
import type { HostMapping } from "./portability";
import { assertHandoffAccount, assertPortableInstance } from "./portability";
import { resumeControllerSockets, closeControllerSockets } from "../../../lib/ws";
import { remoteSessionHeaders } from "./relay-session";
import { connectionSchema, deviceConnection } from "./device-session";
import { closeInstanceRelays } from "./desktop-relay";
import { discoverInstance } from "./instance-discovery";

const token = () => randomBytes(32).toString("base64url");
const key = (value: string) => `instance-pair:${createHash("sha256").update(value).digest("hex")}`;
const pairingSchema = z.object({
  protocol: z.literal(1),
  kind: z.literal("connection"),
  origin: z.string().transform(instanceOrigin),
  installationId: z.string().uuid(),
  token: z.string().regex(/^[\w-]{43}$/),
});

/** Pairing grants a device session as the caller, never an instance-wide token.
 * The code is hashed at rest, expires in ten minutes and is consumed atomically. */
export async function createPairingCode(userId: string, organizationId: string, origin: string) {
  const state = await controllerState();
  if (state.role !== "active") throw new AppError("Pair with the active instance.", 409);
  const value = token(),
    expiresAt = new Date(Date.now() + 10 * 60_000);
  await db.insert(schema.verification).values({
    id: key(value),
    identifier: "instance-pair",
    value: JSON.stringify({ userId, organizationId }),
    expiresAt,
  });
  const code = Buffer.from(
    JSON.stringify({
      protocol: 1,
      kind: "connection",
      origin: instanceOrigin(origin),
      installationId: state.installationId,
      token: value,
    }),
  ).toString("base64url");
  return { code, expiresAt: expiresAt.toISOString() };
}

export async function claimPairingCode(value: string, origin: string): Promise<InstanceConnection> {
  if (!/^[\w-]{43}$/.test(value)) throw new AppError("Invalid connection code.", 401);
  const state = await controllerState();
  if (state.role !== "active") throw new AppError("This instance is not active.", 409);
  return db.transaction(async (tx) => {
    const [claim] = await tx
      .delete(schema.verification)
      .where(
        and(eq(schema.verification.id, key(value)), gt(schema.verification.expiresAt, new Date())),
      )
      .returning();
    if (!claim)
      throw new AppError(
        "This connection code expired or has already been used. Generate a new one on the remote instance.",
        401,
      );
    const identity = z
      .object({ userId: z.string(), organizationId: z.string() })
      .parse(JSON.parse(claim.value));
    const [membership] = await tx
      .select()
      .from(schema.member)
      .where(
        and(
          eq(schema.member.userId, identity.userId),
          eq(schema.member.organizationId, identity.organizationId),
        ),
      );
    if (!membership) throw new AppError("The user no longer has access to this workspace.", 403);
    const sessionToken = token();
    await tx.insert(schema.session).values({
      id: randomUUID(),
      token: sessionToken,
      userId: identity.userId,
      activeOrganizationId: identity.organizationId,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
      userAgent: "Openship Desktop (paired instance)",
    });
    return deviceConnection(origin, state.installationId, sessionToken);
  });
}

export async function connectInstance(value: string): Promise<void> {
  if (env.DEPLOY_MODE !== "desktop")
    throw new AppError("Open Openship Desktop to connect to another instance.", 409);
  const code = pairingSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
  const response = await fetch(`${code.origin}/api/system/instance/pair/claim`, {
    method: "POST",
    redirect: "error",
    headers: { authorization: `Bearer ${code.token}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    throw new AppError(
      "The connection code could not be exchanged. Generate a new code on the remote instance.",
      409,
    );
  const connection = connectionSchema.parse(await response.json());
  if (connection.installationId !== code.installationId || connection.origin !== code.origin)
    throw new AppError("The remote instance does not match this connection code.", 409);
  await attachConnection(connection);
}

/** Connecting by address leaves authentication to the existing login/invitation
 * endpoints. A public identity document is never an authenticated session. */
export async function connectInstanceAddress(value: string): Promise<void> {
  if (env.DEPLOY_MODE !== "desktop")
    throw new AppError("Open Openship Desktop to connect to another instance.", 409);
  const { origin, installationId } = await discoverInstance(value);
  await attachConnection({ origin, installationId, cookies: {} }, true);
}

async function attachConnection(
  connection: InstanceConnection,
  keepExistingSession = false,
): Promise<void> {
  await withAdvisoryLock("instance-handoff", async () => {
    const state = await controllerState();
    if (!["active", "connected", "retired"].includes(state.role))
      throw new AppError("Finish the current move first.", 409);
    if (
      state.handoffId &&
      !["complete", "aborted"].includes((await peer.journal(state.handoffId)).status)
    )
      throw new AppError("Finish or cancel the pending move first.", 409);
    if (connection.installationId === state.installationId)
      throw new AppError("This is already the local instance.", 409);
    if (
      state.role === "retired" &&
      connection.installationId !== controllerConnection(state)?.installationId
    )
      throw new AppError(
        "Reconnect to the instance this Desktop moved to before choosing another instance.",
        409,
      );
    const current = controllerConnection(state);
    // Another invitation on the same instance should reuse the person's
    // authenticated session. Never carry cookies to a different origin or
    // installation, even when the other half of its identity matches.
    if (
      keepExistingSession &&
      ["connected", "retired"].includes(state.role) &&
      current?.origin === connection.origin &&
      current.installationId === connection.installationId
    )
      return;
    // A migrated source must never regain authority over its stale database by
    // pressing Disconnect. An unrelated paused local instance may be resumed.
    await setControllerRole(
      state.role === "retired" ? "retired" : "connected",
      state.handoffId,
      db,
      connection,
    );
    await stopController();
    resumeControllerSockets();
  });
}

export async function disconnectInstance(): Promise<void> {
  await withAdvisoryLock("instance-handoff", async () => {
    const state = await controllerState();
    if (env.DEPLOY_MODE !== "desktop" || state.role !== "connected")
      throw new AppError("Use Move back to Desktop to return with your current data.", 409);
    await setControllerRole("active", null, db, null);
    // Connected mode has no local workers to drain, but its old peer's SSE and
    // terminal connections must end before this Desktop resumes local work.
    closeInstanceRelays();
    closeControllerSockets();
  });
  await startController();
}

async function connectedDesktop(): Promise<InstanceConnection> {
  const state = await controllerState(),
    connection = controllerConnection(state);
  if (
    env.DEPLOY_MODE !== "desktop" ||
    !["retired", "connected"].includes(state.role) ||
    !connection
  )
    throw new AppError("This Desktop is not connected to a remote instance.", 409);
  return connection;
}

/** Read the source's portability requirements as the connected user. Local
 * Desktop records cannot describe apps running on a previously hosted instance. */
export async function connectedSourceHosts(): Promise<Array<{ id: string; name: string }>> {
  const connection = await connectedDesktop();
  const response = await fetch(`${connection.origin}/api/system/instance`, {
    headers: remoteSessionHeaders(connection),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  }).catch((diagnosticFailure) => {
    observeCaughtError(diagnosticFailure, "api/modules/system/instance/instance-connection");
    throw new AppError("Could not reach the connected instance. Check its connection and retry.", 502);
  });
  if (!response.ok) {
    const error = (await response.json().catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "api/modules/system/instance/instance-connection"); return ({}); })) as { error?: string };
    throw new AppError(
      error.error ?? "The remote administrator must authorize this move.",
      response.status,
    );
  }
  const source = z
    .object({
      installationId: z.string().uuid(),
      role: z.string(),
      localHosts: z.array(z.object({ id: z.string(), name: z.string() })),
    })
    .parse(await response.json());
  if (source.installationId !== connection.installationId)
    throw new AppError("The active remote instance changed. Reconnect before moving.", 409);
  if (source.role !== "active")
    throw new AppError("Finish the remote instance's current move first.", 409);
  return source.localHosts;
}

/** Pull the latest remote state. No inbound connection to a Desktop behind NAT
 * is needed, and its old local snapshot is never used as the active database. */
export async function returnToDesktop(
  ownerUserId: string,
  origin: string,
  mapping?: HostMapping,
): Promise<string> {
  const connection = await connectedDesktop();
  const headers = remoteSessionHeaders(connection);
  headers.set("content-type", "application/json");
  const response = await fetch(`${connection.origin}/api/system/instance/offer`, {
    method: "POST",
    redirect: "error",
    headers,
    body: JSON.stringify({ direction: "source", mapping }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    const error = (await response.json().catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "api/modules/system/instance/instance-connection"); return ({}); })) as { error?: string };
    throw new AppError(
      error.error ??
        "The remote administrator must authorize this move. Create a move code on the remote instance.",
      response.status,
    );
  }
  const offer = z.object({ code: z.string() }).parse(await response.json());
  const remote = peer.decodeHandoffCode(offer.code);
  if (remote.installationId !== connection.installationId || remote.origin !== connection.origin)
    throw new AppError("The active remote instance changed. Reconnect before moving.", 409);
  const local = await peer.createHandoffOffer({
    direction: "target",
    ownerUserId,
    origin,
    peer: remote,
  });
  await peer.bindPeer(local.id, remote);
  void resumeHandoff(local.id, origin);
  return local.id;
}

export async function moveToPreviousInstance(
  ownerUserId: string,
  origin: string,
  mapping?: HostMapping,
): Promise<string> {
  const connection = await peer.previousInstanceConnection();
  if (!connection) throw new AppError("Choose the destination instance first.", 409);
  await assertHandoffAccount(ownerUserId);
  await assertPortableInstance(mapping);
  const headers = remoteSessionHeaders(connection);
  headers.set("content-type", "application/json");
  const response = await fetch(`${connection.origin}/api/system/instance/offer`, {
    method: "POST",
    redirect: "error",
    headers,
    body: JSON.stringify({ direction: "target" }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok)
    throw new AppError(
      "The previous instance is unavailable or its connection expired. Open Receive a move there and use its new code.",
      409,
    );
  const remote = peer.decodeHandoffCode(
    z.object({ code: z.string() }).parse(await response.json()).code,
  );
  if (remote.installationId !== connection.installationId || remote.origin !== connection.origin)
    throw new AppError("The previous instance changed. Use a new receive code.", 409);
  const local = await peer.createHandoffOffer({
    direction: "source",
    ownerUserId,
    origin,
    mapping,
    peer: remote,
  });
  await peer.bindPeer(local.id, remote);
  void resumeHandoff(local.id, origin);
  return local.id;
}
