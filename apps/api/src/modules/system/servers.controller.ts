/**
 * Servers CRUD controller - manage SSH server configurations.
 *
 * Security: Gated behind localOnly + authMiddleware (no cloud, no unauthenticated).
 */

import type { Context } from "hono";
import { repos } from "@repo/db";
import { hostControlDisabled } from "@repo/adapters";
import { invalidateOpenRestyPaths } from "@/lib/openresty-paths";
import { invalidateHostCapacity } from "@/lib/host-capacity";
import { env } from "../../config";
import { sshManager, type ReachabilityDiagnosis } from "../../lib/ssh-manager";
import { resolvesToLocalHost } from "@/lib/self-host";
import { boxOwningOrgId } from "@/lib/box-org";
import { ensureLocalServer, localServerHostChannel } from "@/lib/startup/self-server";
import { encryptSecretField } from "@/lib/credential-encryption";
import { getRequestContext } from "../../lib/request-context";
import { permission } from "../../lib/permission";
import { audit, auditContextFrom } from "../../lib/audit";
import { assertNotCloud } from "../../lib/controller-helpers";
import { primeGeo, countryForIp } from "@/lib/geo-ip";
import { execOnHost } from "../../lib/agent-exec";

/** Public shape - what the controller returns to clients (no SSH secrets). */
function serializeServer(s: Awaited<ReturnType<typeof repos.server.get>>) {
  if (!s) return null;
  return {
    id: s.id,
    name: s.name,
    // The auto-registered host row (VPS / server-host mode). The dashboard
    // badges it "This Server" and hides SSH-credential fields for it.
    isLocal: s.isLocal,
    sshHost: s.sshHost,
    sshPort: s.sshPort,
    sshUser: s.sshUser,
    sshAuthMethod: s.sshAuthMethod,
    sshKeyPath: s.sshKeyPath,
    // Never return the key material itself — only whether one is stored, so the
    // edit form can offer "a key is stored; leave blank to keep it" (same idea as
    // the password field, which is simply absent from this shape).
    hasStoredKeyMaterial: !!s.sshPrivateKey,
    sshJumpHost: s.sshJumpHost,
    sshArgs: s.sshArgs,
    createdAt: s.createdAt,
    // ISO country for the row's flag; null for hostnames/private IPs or until
    // the geo DB is warmed (callers prime it via primeGeo before serializing).
    country: countryForIp(s.sshHost),
  };
}

/** GET /servers - list servers in the caller's active organization. */
export async function listServers(c: Context) {
  const cloudGuard = assertNotCloud(c); if (cloudGuard) return cloudGuard;

  // Org-scoped: only the caller's org's servers.
  const ctx = getRequestContext(c);
  // Self-heal: "this box is a deploy target" is an invariant about the MACHINE, so
  // materialize it on read instead of trusting whichever install branch ran (that
  // trust is why a free-domain install listed no servers). Idempotent, single-flight
  // and a no-op — one findLocal — once the row exists.
  await ensureLocalServer().catch(() => null);
  const rows = await repos.server.listByOrganization(ctx.organizationId);
  // Host control off (`openship up --no-host-control`): this box is not a deploy
  // target and every host operation refuses, so the local row is hidden rather
  // than listed-but-dead. Enforced by createHostExecutor throwing — this only
  // stops the UI from offering something the API will reject.
  const all = hostControlDisabled() ? rows.filter((s) => !s.isLocal) : rows;
  await primeGeo();
  // Projects currently deployed to each server (active deployment → meta.serverId).
  const projectCounts = await repos.project
    .countActiveByServer(ctx.organizationId)
    .catch(() => ({} as Record<string, number>));
  // The local row's container→host channel, as an ANNOTATION (#509). Never a filter:
  // ordinary container deploys run over the mounted Docker socket and survive a dead
  // channel, so hiding the row would break them — only `hostControlDisabled()` above
  // withholds it. Null for a remote row, and null when the diagnosis itself fails.
  const channels = await Promise.all(
    // `.catch` at the call site as well as inside: one rejected probe must not 500 the
    // whole list. An annotation that can break the page it annotates is a gate.
    all.map((s) => (s.isLocal ? localServerHostChannel(s.id).catch(() => null) : null)),
  );
  return c.json(
    all.map((s, i) => ({
      ...serializeServer(s),
      projectCount: projectCounts[s.id] ?? 0,
      hostChannel: channels[i] ?? null,
    })),
  );
}

/** GET /servers/:id - get a single server. */
export async function getServer(c: Context) {
  const cloudGuard = assertNotCloud(c); if (cloudGuard) return cloudGuard;

  const id = c.req.param("id")!;
  // Primary gate: permission resolver (404 on deny, IDOR-safe).
  await permission.assert(getRequestContext(c), { resourceType: "server", resourceId: id, action: "read" });
  // Org-scoped: out-of-org server ids 404 indistinguishably from missing.
  const ctx = getRequestContext(c);
  const server = await repos.server.getInOrganization(id, ctx.organizationId);
  if (!server) return c.json({ error: "Server not found" }, 404);

  await primeGeo();
  // Same name, same source, same meaning as the list's `projectCount` — the detail
  // view decides "is an absent edge an issue or an offer" and "what does Remove
  // server unbind" from it, and a second field name would let those disagree with
  // the fleet view. It's also the only PRE-delete reading of that number:
  // deleteServer's `unboundProjects` ships with the response, i.e. once the row is
  // already gone, so no confirm can be built from it.
  const projectCounts = await repos.project
    .countActiveByServer(ctx.organizationId)
    .catch(() => ({}) as Record<string, number>);
  return c.json({
    ...serializeServer(server),
    projectCount: projectCounts[id] ?? 0,
    hostChannel: server.isLocal
      ? await localServerHostChannel(server.id).catch(() => null)
      : null,
  });
}

/**
 * GET /servers/:id/reachability - lightweight liveness probe for the list view.
 * Reuses sshManager.diagnoseReachability (already-connected → instant true, else a
 * short TCP probe behind the circuit breaker). Never throws — an unreachable
 * host or transient failure is just `{ reachable: false }`.
 *
 * Carries the REASON too: `target` is the address we actually dial, which for THIS
 * box is the container→host SSH bridge and not the row's display `sshHost`. Without
 * it the UI could only name `127.0.0.1` and sent operators to check a port that is
 * supposed to be closed, on the wrong machine (#490).
 */
export async function probeReachability(c: Context) {
  const cloudGuard = assertNotCloud(c); if (cloudGuard) return cloudGuard;

  const id = c.req.param("id")!;
  await permission.assert(getRequestContext(c), { resourceType: "server", resourceId: id, action: "read" });
  const ctx = getRequestContext(c);
  const server = await repos.server.getInOrganization(id, ctx.organizationId);
  if (!server) return c.json({ error: "Server not found" }, 404);

  const d: ReachabilityDiagnosis = await sshManager
    .diagnoseReachability(id)
    .catch(() => ({ reachable: false, code: "unknown" }));
  return c.json({
    reachable: d.reachable,
    code: d.code,
    target: d.target ?? null,
    port: d.port ?? null,
    hint: d.hint ?? null,
    rule: d.rule ?? null,
    channel: d.channel ?? null,
  });
}

/** POST /servers - create a new server */
export async function createServer(c: Context) {
  const cloudGuard = assertNotCloud(c); if (cloudGuard) return cloudGuard;

  const body = await c.req.json();

  const host = (body.sshHost as string)?.trim();
  if (!host) return c.json({ error: "SSH host is required" }, 400);

  const ctx = getRequestContext(c);

  // Adding THIS host as a server (loopback / the box's own SERVER_IP on a
  // server-host) must NOT create a plain SSH row — deploys/probes would dial the
  // API's own loopback (the container's, when compose-deployed) where there is no
  // sshd → the "Can't reach 127.0.0.1" failure.
  if (resolvesToLocalHost({ sshHost: host, sshPort: body.sshPort, sshJumpHost: body.sshJumpHost })) {
    // Only the box-owning org may register the local host — running on it is
    // code execution on the control plane (host executor + mounted docker socket,
    // DooD ≈ root). A teammate's org (any member can POST /servers) is refused so
    // it can't mint itself a host-root deploy target.
    if (ctx.organizationId !== (await boxOwningOrgId())) {
      return c.json(
        { error: "The local host can't be added as a server in this workspace." },
        400,
      );
    }
    // Adopt the canonical isLocal "This Server" row (create it if nothing has yet)
    // so the box is a first-class, working deploy target with the right transport —
    // never a duplicate loopback SSH row. Through the ONE registration primitive,
    // so this can't race the boot hook / an install call into a second row.
    const local = await ensureLocalServer({ name: body.name?.trim(), sshHost: host });
    if (!local) {
      // Only reachable with host control off (`--no-host-control`): every host
      // operation refuses and listServers hides the row, so creating one would hand
      // back a server that cannot work. Say so instead.
      return c.json(
        { error: "Host control is disabled on this instance, so the local host can't be a deploy target." },
        400,
      );
    }
    return c.json(serializeServer(local), 201);
  }

  const server = await repos.server.create({
    organizationId: ctx.organizationId,
    name: body.name?.trim() || null,
    sshHost: host,
    sshPort: body.sshPort ?? 22,
    sshUser: body.sshUser?.trim() || "root",
    sshAuthMethod: body.sshAuthMethod || null,
    // Encrypted at rest with AES-256-GCM (key derived from BETTER_AUTH_SECRET).
    // Decrypted only inside `buildSshConfig` when the ssh2 client needs it.
    sshPassword: encryptSecretField(body.sshPassword),
    sshKeyPath: body.sshKeyPath || null,
    sshPrivateKey: encryptSecretField(body.sshPrivateKey),
    sshKeyPassphrase: encryptSecretField(body.sshKeyPassphrase),
    sshJumpHost: body.sshJumpHost?.trim() || null,
    sshArgs: body.sshArgs?.trim() || null,
  });

  sshManager.invalidate(server.id);
  await invalidateOpenRestyPaths(server.id);
  // createServer upserts, so this id may now point at DIFFERENT hardware —
  // re-probe rather than validate resource limits against the old box's specs.
  await invalidateHostCapacity(ctx.organizationId, server.id).catch((err: unknown) =>
    console.error("[server.create] capacity cache cleanup failed:", err),
  );

  // Names + non-secret connection details only. SSH passwords & key
  // passphrases are encrypted at rest; never include them in the audit.
  audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
    eventType: "server.added",
    resourceType: "server",
    resourceId: server.id,
    after: {
      name: server.name,
      sshHost: server.sshHost,
      sshPort: server.sshPort,
      sshUser: server.sshUser,
      sshAuthMethod: server.sshAuthMethod,
      sshJumpHost: server.sshJumpHost,
    },
  });

  return c.json(serializeServer(server), 201);
}

/** PATCH /servers/:id - update a server */
export async function updateServer(c: Context) {
  const cloudGuard = assertNotCloud(c); if (cloudGuard) return cloudGuard;

  const id = c.req.param("id")!;
  // Primary gate: permission resolver. Updating server config is a write.
  await permission.assert(getRequestContext(c), { resourceType: "server", resourceId: id, action: "write" });
  // Org-scoped: refuse to update a server outside the caller's org.
  const ctx = getRequestContext(c);
  const existing = await repos.server.getInOrganization(id, ctx.organizationId);
  if (!existing) return c.json({ error: "Server not found" }, 404);

  const body = await c.req.json();
  const patch: Record<string, unknown> = {};

  if (body.name !== undefined) patch.name = body.name?.trim() || null;
  if (body.sshHost !== undefined) patch.sshHost = body.sshHost?.trim() || existing.sshHost;
  if (body.sshPort !== undefined) patch.sshPort = body.sshPort ?? 22;
  if (body.sshUser !== undefined) patch.sshUser = body.sshUser?.trim() || "root";
  if (body.sshAuthMethod !== undefined) patch.sshAuthMethod = body.sshAuthMethod || null;
  // Sensitive fields are encrypted at rest; see lib/credential-encryption.
  if (body.sshPassword !== undefined) patch.sshPassword = encryptSecretField(body.sshPassword);
  if (body.sshKeyPath !== undefined) patch.sshKeyPath = body.sshKeyPath || null;
  if (body.sshPrivateKey !== undefined) patch.sshPrivateKey = encryptSecretField(body.sshPrivateKey);
  if (body.sshKeyPassphrase !== undefined) patch.sshKeyPassphrase = encryptSecretField(body.sshKeyPassphrase);
  if (body.sshJumpHost !== undefined) patch.sshJumpHost = body.sshJumpHost?.trim() || null;
  if (body.sshArgs !== undefined) patch.sshArgs = body.sshArgs?.trim() || null;

  if (Object.keys(patch).length === 0) {
    return c.json({ error: "No fields to update" }, 400);
  }

  const updated = await repos.server.update(id, patch);
  sshManager.invalidate(id);
  await invalidateOpenRestyPaths(id);
  // Edited connection details can repoint this row at another machine (and a
  // resize changes the specs of the same one) — re-probe capacity either way.
  await invalidateHostCapacity(ctx.organizationId, id).catch((err: unknown) =>
    console.error("[server.update] capacity cache cleanup failed:", err),
  );

  // Audit only the fields the caller intended to touch. Skip secrets entirely.
  const auditAfter: Record<string, unknown> = {};
  if (body.name !== undefined) auditAfter.name = updated?.name ?? null;
  if (body.sshHost !== undefined) auditAfter.sshHost = updated?.sshHost ?? null;
  if (body.sshPort !== undefined) auditAfter.sshPort = updated?.sshPort ?? null;
  if (body.sshUser !== undefined) auditAfter.sshUser = updated?.sshUser ?? null;
  if (body.sshAuthMethod !== undefined) auditAfter.sshAuthMethod = updated?.sshAuthMethod ?? null;
  if (body.sshKeyPath !== undefined) auditAfter.sshKeyPath = updated?.sshKeyPath ?? null;
  if (body.sshJumpHost !== undefined) auditAfter.sshJumpHost = updated?.sshJumpHost ?? null;
  if (body.sshArgs !== undefined) auditAfter.sshArgs = updated?.sshArgs ?? null;
  // Sentinels for credential rotation (no values).
  if (body.sshPassword !== undefined) auditAfter.sshPasswordChanged = true;
  if (body.sshPrivateKey !== undefined) auditAfter.sshPrivateKeyChanged = true;
  if (body.sshKeyPassphrase !== undefined) auditAfter.sshKeyPassphraseChanged = true;

  audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
    eventType: "server.updated",
    resourceType: "server",
    resourceId: id,
    after: auditAfter,
  });

  return c.json(serializeServer(updated));
}

/** DELETE /servers/:id - delete a server */
export async function deleteServer(c: Context) {
  const cloudGuard = assertNotCloud(c); if (cloudGuard) return cloudGuard;

  const id = c.req.param("id")!;
  // Primary gate: deleting a server is admin-tier (destructive).
  await permission.assert(getRequestContext(c), { resourceType: "server", resourceId: id, action: "admin" });
  // Org-scoped: refuse to delete a server outside the caller's org.
  const ctx = getRequestContext(c);
  const existing = await repos.server.getInOrganization(id, ctx.organizationId);
  if (!existing) return c.json({ error: "Server not found" }, 404);
  // The auto-registered host ("This Server") is not user-removable — it IS the
  // machine OpenShip runs on, and the boot reconcile would just recreate it.
  if (existing.isLocal) {
    return c.json({ error: "This is the current host and can't be removed." }, 400);
  }

  // Count what this unbinds BEFORE the row goes. `project.server_id` is ON DELETE SET
  // NULL, so once it's deleted nothing records which projects pointed here. Their next
  // deploy falls through the nulled column to a stale `meta.serverId` and fails with an
  // org-mismatch message that cannot mention a server it can no longer read — so this
  // count is the only thing tying that error back to this action. Same coalesce rule the
  // deploy resolver uses, so it counts the projects that will actually break.
  const counts = await repos.project
    .countActiveByServer(ctx.organizationId)
    .catch(() => ({}) as Record<string, number>);
  const unboundProjects = counts[id] ?? 0;

  await repos.server.delete(id);
  // Server is hard-deleted — purge any per-server resource grants so
  // they don't linger as orphan rows. Mail-server grants on the same
  // id need cleanup too since they share the server's id.
  await repos.resourceGrant
    .deleteForResource(ctx.organizationId, "server", id)
    .catch((err: unknown) =>
      console.error("[server.delete] grant cleanup failed:", err),
    );
  await repos.resourceGrant
    .deleteForResource(ctx.organizationId, "mail_server", id)
    .catch((err: unknown) =>
      console.error("[server.delete] mail_server grant cleanup failed:", err),
    );
  sshManager.invalidate(id);
  await invalidateOpenRestyPaths(id);
  // Drop the cached CPU/RAM capacity for this box so a re-added server (or a
  // reused id) re-probes instead of validating resource limits against the
  // hardware of a machine that's gone.
  await invalidateHostCapacity(ctx.organizationId, id).catch((err: unknown) =>
    console.error("[server.delete] capacity cache cleanup failed:", err),
  );

  audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
    eventType: "server.removed",
    resourceType: "server",
    resourceId: id,
    after: {
      name: existing.name,
      sshHost: existing.sshHost,
      unboundProjects,
    },
  });

  return c.json({ ok: true, unboundProjects });
}

/**
 * POST /api/system/servers/:id/exec — run a command on this server's host.
 *
 * The sanctioned execution point for an agent, and the reason it exists: the only
 * other way to run a command was a custom command JOB, whose `job` tag is an
 * org-singleton — so that grant reaches EVERY server in the org and could not be
 * narrowed to one. Here the permission is asserted on the server itself, so a
 * `{server, <id>, [admin]}` grant confines an agent to exactly this box.
 *
 * `admin` rather than `write`: this is unrestricted shell as the server's SSH user
 * (root in Openship's model), which is strictly more than any other `server:write`
 * route can do. It is the same tier `/api/system/install` asserts, which is the
 * closest existing capability.
 */
export async function execOnServer(c: Context) {
  const cloudGuard = assertNotCloud(c); if (cloudGuard) return cloudGuard;

  const id = c.req.param("id")!;
  // Primary gate: permission resolver (404 on deny, IDOR-safe). Asserted BEFORE the
  // row is read, so a caller without access cannot distinguish "no such server"
  // from "not yours".
  await permission.assert(getRequestContext(c), { resourceType: "server", resourceId: id, action: "admin" });
  const ctx = getRequestContext(c);
  const server = await repos.server.getInOrganization(id, ctx.organizationId);
  if (!server) return c.json({ error: "Server not found" }, 404);

  const body = await c.req.json<{
    command?: string;
    cwd?: string;
    timeoutMs?: number;
    maxOutputBytes?: number;
  }>();
  const command = body.command?.trim();
  if (!command) return c.json({ error: "command required", code: "COMMAND_REQUIRED" }, 400);

  const result = await sshManager
    .withExecutor(id, (executor) =>
      execOnHost(executor, {
        command,
        cwd: body.cwd,
        timeoutMs: body.timeoutMs,
        maxOutputBytes: body.maxOutputBytes,
      }),
    )
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      return { transportError: message };
    });

  if ("transportError" in result) {
    return c.json(
      { error: `Could not reach the server: ${result.transportError}`, code: "SERVER_UNREACHABLE" },
      502,
    );
  }

  // The command IS recorded, unlike the counts-only audit used elsewhere: an exec
  // that ran is the single most important thing to be able to reconstruct later, and
  // the operator who granted the access is entitled to see what was done with it.
  // Output is NOT recorded — it is unbounded and may contain secrets the command read.
  audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
    eventType: "server.exec",
    resourceType: "server",
    resourceId: id,
    after: {
      command,
      cwd: body.cwd ?? null,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      truncated: result.truncated,
      durationMs: result.durationMs,
      outputBytes: result.output.length,
    },
  });

  return c.json({ data: result });
}
