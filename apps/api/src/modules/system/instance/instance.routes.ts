import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { timingSafeEqual } from "node:crypto";
import { AppError, instanceOrigin } from "@repo/core";
import { secureRouter } from "../../../lib/secure-router";
import { getRequestContext } from "../../../lib/request-context";
import { requireInstanceAdmin, assertInstanceAdmin } from "../../../middleware/instance-admin";
import { authMiddleware } from "../../../middleware/auth";
import { requestApiPublicUrl } from "@repo/platform/engine/lib/public-url";
import { env } from "@repo/platform/engine/config/env";
import { readApiVersion } from "@repo/platform/engine/lib/release-resolver";
import { db, eq, schema } from "@repo/db";
import { operationContext } from "../../../lib/operation-context";
import { audit, operationAuditContext } from "@repo/platform/engine/lib/audit-emitter";
import {
  controllerState,
  controllerConnection,
  controllerEnvironmentReady,
} from "./controller-state";
import { assertHandoffAccount, assertPortableInstance, needsHostMapping } from "./portability";
import { handoffRunning, resumeHandoff, cancelHandoff } from "./handoff-client";
import {
  createPairingCode,
  claimPairingCode,
  connectInstance,
  connectInstanceAddress,
  disconnectInstance,
  returnToDesktop,
  moveToPreviousInstance,
  connectedSourceHosts,
} from "./instance-connection";
import {
  beginProvisioning,
  provisionInput,
  provisionInstance,
  provisioningRunning,
} from "./provision-instance";
import * as peer from "./handoff-peer";
import { zeroAuthAllowed } from "../../../middleware/zero-auth-guard";
import { connectionSchema } from "./device-session";

const r = secureRouter(new Hono(), {
  module: "instance",
  basePath: "/api/system/instance",
  localOnly: true,
  mcpExcluded:
    "Instance relocation requires an administrator's reviewed handoff in Settings → Instance.",
});
const admin = requireInstanceAdmin();
const limited = bodyLimit({ maxSize: 32_000 });
const origin = (request: Request) =>
  instanceOrigin(requestApiPublicUrl(request).replace(/\/api\/?$/, ""));
const mapping = z
  .object({
    sourceServerId: z.string().min(1).max(200),
    connectionServerId: z.string().min(1).max(200),
  })
  .optional();
// Restoring an instance replaces its user/session tables. The physical Desktop
// owner must still be able to resume/cancel during that window. This exception
// is kernel-loopback + launcher-declared zero-auth only; a remote browser must
// always pass the normal instance-administrator check.
const recoveryAccess: import("hono").MiddlewareHandler = async (c, next) => {
  if (
    env.DEPLOY_MODE === "desktop" &&
    (await zeroAuthAllowed(c)).ok &&
    (await controllerState()).role !== "active"
  )
    return next();
  return authMiddleware(c, async () => {
    const response = await admin(c, next);
    // This middleware is composed manually for the Desktop recovery exception.
    // Preserve a rejected administrator check instead of dropping its response.
    if (response) c.res = response;
  });
};
const recoveryReason =
  "Authenticated instance administrator, or the trusted loopback Desktop owner while its user tables are being replaced.";

r.public(
  "get",
  "/identity",
  {
    reason:
      "Public installation identity and protocol version for a user-reviewed Desktop connection; no credentials or account metadata.",
  },
  async (c) => {
    const state = await controllerState();
    if (state.role !== "active") return c.json({ error: "This instance is not active." }, 503);
    return c.json({
      protocol: 1,
      installationId: state.installationId,
      origin: origin(c.req.raw),
      version: readApiVersion(),
    });
  },
);

r.public("get", "/", { reason: recoveryReason }, recoveryAccess, async (c) => {
  c.header("Cache-Control", "no-store");
  if (c.req.query("source") === "connected")
    return c.json({ localHosts: await connectedSourceHosts() });
  const state = await controllerState();
  const row = state.handoffId ? await peer.journal(state.handoffId) : null;
  const connection = controllerConnection(state);
  const previousConnection = await peer.previousInstanceConnection();
  const userId = c.get("ctx")?.userId ?? state.desktopUserId;
  const [owner] = userId
    ? await db
        .select({ autoProvisioned: schema.user.autoProvisioned })
        .from(schema.user)
        .where(eq(schema.user.id, userId))
    : [];
  const hosts = await db
    .select({
      id: schema.servers.id,
      name: schema.servers.name,
      isLocal: schema.servers.isLocal,
      sshHost: schema.servers.sshHost,
      sshJumpHost: schema.servers.sshJumpHost,
    })
    .from(schema.servers);
  return c.json({
    protocol: 1,
    installationId: state.installationId,
    role: state.role,
    ready: state.role === "active" && controllerEnvironmentReady(state),
    version: readApiVersion(),
    desktop: env.DEPLOY_MODE === "desktop",
    accountReady: !!owner && !owner.autoProvisioned,
    connection: connection
      ? { origin: connection.origin, installationId: connection.installationId }
      : null,
    previousInstance: previousConnection ? { origin: previousConnection.origin } : null,
    localHosts: hosts.filter(needsHostMapping).map(({ id, name }) => ({ id, name })),
    handoff: row
      ? {
          id: row.id,
          direction: row.direction,
          status: row.status,
          error: row.error,
          running: handoffRunning(row.id) || provisioningRunning(row.id),
          peerOrigin: row.peerOrigin,
          provisioning: row.provisioning,
        }
      : null,
  });
});

r.post("/preflight", { tag: "settings:admin", readOnly: true }, admin, limited, async (c) => {
  await assertInstanceAdmin(getRequestContext(c));
  const input = z.object({ mapping }).parse(await c.req.json());
  await assertHandoffAccount(getRequestContext(c).userId);
  await assertPortableInstance(input.mapping);
  return c.json({ ready: true });
});

r.post("/offer", { tag: "settings:admin" }, admin, limited, async (c) => {
  const ctx = getRequestContext(c);
  await assertInstanceAdmin(ctx);
  const input = z
    .object({ direction: z.enum(["source", "target"]), mapping })
    .parse(await c.req.json());
  if (input.direction === "source") {
    await assertHandoffAccount(ctx.userId);
    await assertPortableInstance(input.mapping);
  }
  const code = await peer.createHandoffOffer({
    ...input,
    ownerUserId: ctx.userId,
    origin: origin(c.req.raw),
  });
  c.header("Cache-Control", "no-store");
  return c.json({ code: peer.encodeHandoffCode(code), id: code.id });
});

r.post("/move", { tag: "settings:admin" }, admin, limited, async (c) => {
  const ctx = getRequestContext(c);
  await assertInstanceAdmin(ctx);
  const input = z
    .object({ code: z.string().min(1).max(4_000), mapping, confirmReplace: z.literal(true) })
    .parse(await c.req.json());
  const remote = peer.decodeHandoffCode(input.code);
  const direction = remote.direction === "source" ? "target" : "source";
  if (direction === "source") {
    await assertHandoffAccount(ctx.userId);
    await assertPortableInstance(input.mapping);
  }
  const local = await peer.createHandoffOffer({
    direction,
    ownerUserId: ctx.userId,
    origin: origin(c.req.raw),
    peer: remote,
    mapping: input.mapping,
  });
  await peer.bindPeer(local.id, remote);
  await audit.record(operationAuditContext(operationContext(c)), {
    eventType: "instance.move_requested",
    resourceType: "instance",
    resourceId: local.id,
    after: { direction, peerOrigin: remote.origin },
  });
  void resumeHandoff(local.id, local.origin);
  return c.json({ id: local.id }, 202);
});

r.post("/provision", { tag: "settings:admin" }, admin, limited, async (c) => {
  const ctx = operationContext(c);
  const id = await beginProvisioning(
    ctx,
    provisionInput.parse(await c.req.json()),
    origin(c.req.raw),
  );
  await audit.record(operationAuditContext(ctx), {
    eventType: "instance.server_move_requested",
    resourceType: "instance",
    resourceId: id,
  });
  return c.json({ id }, 202);
});

r.public("post", "/resume", { reason: recoveryReason }, recoveryAccess, limited, async (c) => {
  const state = await controllerState();
  if (!state.handoffId) throw new AppError("There is no move to resume.", 409);
  const row = await peer.journal(state.handoffId);
  if (row.provisioning && !row.peerId)
    void provisionInstance(operationContext(c), row.id, origin(c.req.raw));
  else void resumeHandoff(row.id, origin(c.req.raw));
  return c.json({ id: state.handoffId }, 202);
});

r.public("post", "/cancel", { reason: recoveryReason }, recoveryAccess, async (c) => {
  const state = await controllerState();
  if (state.handoffId && provisioningRunning(state.handoffId))
    throw new AppError(
      "Server preparation is still running. Check its deployment before cancelling this move.",
      409,
    );
  if (state.handoffId) await cancelHandoff(state.handoffId);
  return c.json({ success: true });
});

r.post("/connect", { tag: "settings:admin" }, admin, limited, async (c) => {
  const input = z.object({ code: z.string().min(1).max(4_000) }).parse(await c.req.json());
  await connectInstance(input.code);
  c.header(
    "Set-Cookie",
    "openship.instance.session_token=connected; Path=/; HttpOnly; SameSite=Strict",
  );
  return c.json({ success: true });
});
r.post("/connect-address", { tag: "settings:admin" }, admin, limited, async (c) => {
  const input = z
    .object({ origin: z.string().max(400).transform(instanceOrigin), confirmed: z.literal(true) })
    .parse(await c.req.json());
  await connectInstanceAddress(input.origin);
  c.header(
    "Set-Cookie",
    "openship.instance.session_token=connected; Path=/; HttpOnly; SameSite=Strict",
  );
  return c.json({ success: true });
});
r.post("/disconnect", { tag: "settings:admin" }, admin, async (c) => {
  await disconnectInstance();
  c.header(
    "Set-Cookie",
    "openship.instance.session_token=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0",
  );
  return c.json({ success: true });
});
r.post("/return", { tag: "settings:admin" }, admin, limited, async (c) => {
  const input = z.object({ mapping, confirmReplace: z.literal(true) }).parse(await c.req.json());
  return c.json(
    { id: await returnToDesktop(getRequestContext(c).userId, origin(c.req.raw), input.mapping) },
    202,
  );
});
r.post("/move-previous", { tag: "settings:admin" }, admin, limited, async (c) => {
  const input = z.object({ mapping, confirmReplace: z.literal(true) }).parse(await c.req.json());
  return c.json(
    {
      id: await moveToPreviousInstance(
        getRequestContext(c).userId,
        origin(c.req.raw),
        input.mapping,
      ),
    },
    202,
  );
});

// Any authenticated teammate can pair their own Desktop. Moving the WHOLE
// instance above remains instance-admin-only; pairing never grants that role.
r.public(
  "post",
  "/pair",
  {
    reason:
      "Authenticated user creates a short-lived code for their own device session, without instance privileges.",
  },
  authMiddleware,
  async (c) => {
    const state = await controllerState();
    if (["connected", "retired"].includes(state.role) && state.connection) {
      const { relayInstanceRequest } = await import("./desktop-relay");
      return relayInstanceRequest(c, state);
    }
    const ctx = getRequestContext(c);
    c.header("Cache-Control", "no-store");
    return c.json(await createPairingCode(ctx.userId, ctx.organizationId, origin(c.req.raw)));
  },
);
r.public(
  "post",
  "/pair/claim",
  {
    reason:
      "Single-use, hashed ten-minute device pairing code; mints only its issuing user's session.",
  },
  async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(
      await claimPairingCode(
        (c.req.header("authorization") ?? "").replace(/^Bearer /, ""),
        origin(c.req.raw),
      ),
    );
  },
);

// The receiver's bootstrap capability is generated by the deploying controller,
// passed as a secret to the new service and bound to exactly one transfer id.
r.public(
  "post",
  "/bootstrap",
  {
    reason:
      "One-time provisioned receiver capability; cannot create users or activate the controller.",
  },
  limited,
  async (c) => {
    const expected = process.env.OPENSHIP_INSTANCE_RECEIVE_TOKEN ?? "";
    const presented = (c.req.header("authorization") ?? "").replace(/^Bearer /, "");
    if (
      !expected ||
      expected.length !== presented.length ||
      !timingSafeEqual(Buffer.from(expected), Buffer.from(presented))
    )
      throw new AppError("Invalid receiver authorization.", 401);
    const input = z
      .object({ peer: peer.handoffCodeSchema, ownerUserId: z.string().min(1).max(200) })
      .parse(await c.req.json());
    const state = await controllerState();
    if (
      input.peer.id !== process.env.OPENSHIP_INSTANCE_RECEIVE_ID ||
      (state.handoffId && state.handoffId !== input.peer.id) ||
      (!state.handoffId && state.role !== "receiving")
    )
      throw new AppError("This receiver is not awaiting this move.", 409);
    const code = await peer.createHandoffOffer({
      direction: "target",
      ownerUserId: input.ownerUserId,
      origin: origin(c.req.raw),
      peer: input.peer,
    });
    await peer.bindPeer(code.id, input.peer);
    return c.json({ code, version: readApiVersion() });
  },
);

const authorized = async (c: import("hono").Context) =>
  peer.authenticatePeer(
    z.string().uuid().parse(c.req.param("id")),
    (c.req.header("authorization") ?? "").replace(/^Bearer /, ""),
    c.req.param("action") === "abort",
  );
const reason =
  "Authenticated, instance-bound handoff capability. Only the offered transfer can read/import/activate its snapshot.";
r.public("post", "/peer/:id/:action", { reason }, limited, async (c) => {
  const row = await authorized(c),
    action = c.req.param("action"),
    body = await c.req.json();
  c.header("Cache-Control", "no-store");
  switch (action) {
    case "bind":
      await peer.bindPeer(row.id, peer.handoffCodeSchema.parse(body.peer));
      return c.json({ ok: true });
    case "freeze":
      return c.json(await peer.freezeSource(row.id));
    case "stage":
      await peer.stageTarget(row.id, peer.manifestSchema.parse(body.manifest));
      return c.json({ ok: true });
    case "prepare":
      await peer.prepareTarget(row.id);
      return c.json({ ok: true });
    case "retire":
      return c.json(await peer.retireSource(row.id, peer.manifestSchema.parse(body.manifest)));
    case "activate":
      return c.json(
        await peer.activateTarget(
          row.id,
          z
            .string()
            .regex(/^[\w-]{43}$/)
            .parse(body.proof),
          origin(c.req.raw),
        ),
      );
    case "complete": {
      const connection = connectionSchema.parse(body.connection);
      await peer.completeSource(row.id, connection);
      return c.json({ ok: true });
    }
    case "abort":
      return c.json(
        await peer.abortHandoff(
          row.id,
          z
            .string()
            .regex(/^[\w-]{43}$/)
            .optional()
            .parse(body.proof),
        ),
      );
    default:
      return c.notFound();
  }
});
r.public("get", "/peer/:id/chunks/:index", { reason }, async (c) => {
  const row = await authorized(c);
  const index = z.coerce.number().int().nonnegative().parse(c.req.param("index"));
  c.header("Cache-Control", "no-store");
  return new Response(Buffer.from(await peer.getSourceChunk(row.id, index)), {
    headers: { "content-type": "application/octet-stream" },
  });
});
r.public(
  "put",
  "/peer/:id/chunks/:index",
  { reason },
  bodyLimit({ maxSize: 8_000_064 }),
  async (c) => {
    const row = await authorized(c);
    const index = z.coerce.number().int().nonnegative().parse(c.req.param("index"));
    await peer.putTargetChunk(row.id, index, new Uint8Array(await c.req.arrayBuffer()));
    return c.json({ ok: true });
  },
);

export const instanceRoutes = r.hono;
