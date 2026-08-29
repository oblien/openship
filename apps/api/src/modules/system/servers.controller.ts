/**
 * Servers CRUD controller - manage SSH server configurations.
 *
 * Security: Gated behind localOnly + authMiddleware (no cloud, no unauthenticated).
 */

import type { Context } from "hono";
import { repos } from "@repo/db";
import { hostControlDisabled } from "@repo/adapters";
import { safeErrorMessage } from "@repo/core";
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
  // view decides "is an absent edge an issue or an offer" and "how many workloads
  // does Remove server take with it" from it, and a second field name would let
  // those disagree with the fleet view. The removal confirm itemises the same set
  // via GET /servers/:id/deletion-preview, which shares one binding expression
  // with this count (repos.project.boundServerId) so the chip and the list cannot
  // report different numbers.
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
/**
 * Everything on a server row that describes HOW to dial it — i.e. everything an isLocal
 * row does not use. Listed once so a new credential field can't quietly become writable
 * on the one row where writing it means nothing.
 */
const LOCAL_ROW_READONLY_FIELDS = [
  "sshHost",
  "sshPort",
  "sshUser",
  "sshAuthMethod",
  "sshPassword",
  "sshKeyPath",
  "sshPrivateKey",
  "sshKeyPassphrase",
  "sshJumpHost",
  "sshArgs",
] as const;

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

  // #527: an isLocal row's ssh* fields are DISPLAY-ONLY. Every operation on this box goes
  // through the container→host channel, whose credentials come from OPENSHIP_HOST_SSH_*
  // and never from this row (see lib/startup/self-server.ts). Accepting them stored a
  // credential nothing reads, displayed it back as though it were in use, and let
  // `ensureLocalServer`'s reconcile silently revert ssh_user on the next `GET /servers`.
  //
  // That combination is most of what #527 cost its reporter: told their credentials were
  // rejected, they came here, entered a username and key, watched it change nothing, and
  // tried three more key paths. Refusing with the reason is the only answer that ends
  // that loop. `name` stays editable — renaming this row is meaningful and harmless.
  if (existing.isLocal) {
    const attempted = LOCAL_ROW_READONLY_FIELDS.filter((f) => body[f] !== undefined);
    if (attempted.length > 0) {
      return c.json(
        {
          error:
            "This row is the machine Openship runs on, so its SSH details are display-only " +
            "— the connection to this host uses the channel key provisioned by " +
            "`openship up`, not credentials stored here. Re-run `openship up` to change it.",
          fields: attempted,
        },
        400,
      );
    }
  }

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

/**
 * GET /servers/:id/deletion-preview - what "Remove server" is about to take.
 *
 * Read-only and cheap enough for modal open (every lookup is its own `.catch`, so
 * one dead sub-query degrades a line of the confirm instead of blanking it). Mirrors
 * GET /projects/:id/deletion-preview.
 *
 * This exists because the server row is not the blast radius. Every project bound to
 * the box goes with it, and the confirm has to name them BEFORE the operator commits:
 * their env vars are `ON DELETE CASCADE` and the on-server manifest is deliberately
 * secret-free, so "removed from Openship" is reversible in structure and permanently
 * lossy in secrets.
 */
export async function serverDeletionPreview(c: Context) {
  const cloudGuard = assertNotCloud(c); if (cloudGuard) return cloudGuard;

  const id = c.req.param("id")!;
  await permission.assert(getRequestContext(c), { resourceType: "server", resourceId: id, action: "read" });
  const ctx = getRequestContext(c);
  const server = await repos.server.getInOrganization(id, ctx.organizationId);
  if (!server) return c.json({ error: "Server not found" }, 404);

  const [workloads, mail, tunnels, github, destinations] = await Promise.all([
    repos.project.listActiveByServer(ctx.organizationId, id).catch(() => []),
    repos.mailServer.get(id).catch(() => undefined),
    repos.serverTunnel.listByServer(id).catch(() => []),
    repos.serverGithubAuth.getByServer(id).catch(() => undefined),
    // No by-server lookup exists on the backup repo and an org has few
    // destinations, so filter the org list rather than add a method for one line
    // of confirm copy.
    repos.backupDestination.listByOrganization(ctx.organizationId).catch(() => []),
  ]);

  // Gates the "also destroy on the server" option: offering to stop containers on a
  // box that isn't answering would either hang the request or silently orphan every
  // resource. Never throws — an unreachable host is a `false`, not a 500.
  const reachable = server.isLocal
    ? true
    : await sshManager
        .diagnoseReachability(id)
        .then((d: ReachabilityDiagnosis) => d.reachable)
        .catch(() => null);

  return c.json({
    ok: true,
    preview: {
      serverId: server.id,
      serverName: server.name,
      sshHost: server.sshHost,
      isLocal: server.isLocal,
      workloads: workloads.map((w) => ({
        id: w.id,
        name: w.name,
        slug: w.slug,
        environmentName: w.environmentName,
        environmentSlug: w.environmentSlug,
        groupName: w.groupName,
        isApp: w.isApp,
        // The control plane can't be torn down (teardownProject refuses it), so the
        // modal has to mark it rather than promise its removal.
        isControlPlane: w.appTemplateId === "openship",
        // Deliberately no resolved status: there is no batch latest-status query and
        // getProjectStatus already derives live-vs-draft from this pointer alone.
        activeDeploymentId: w.activeDeploymentId,
      })),
      projectCount: workloads.filter((w) => !w.isApp).length,
      appCount: workloads.filter((w) => w.isApp).length,
      // Cascades of the server row itself, from real reads — the confirm must not
      // narrate a consequence the schema doesn't actually have.
      alsoRemoved: {
        mailConfigured: !!mail,
        tunnels: tunnels.length,
        githubRegistration: !!github,
      },
      alsoUnbound: {
        backupDestinations: destinations.filter((d) => d.serverId === id).length,
      },
      reachable,
    },
  });
}

/**
 * DELETE /servers/:id?destroyOnSource=true - remove a server and resolve its workloads.
 *
 * Removing the row alone used to leave every bound project pointing at a server that
 * no longer exists: `project.server_id` nulls out, but each read coalesces the active
 * deployment's `meta.serverId` snapshot, so the project still claims deployTarget
 * "server" and its next deploy dies in resolveOrgServer. So the fate of the workloads
 * is now explicit and always resolved:
 *
 *   default              → recordOnly teardown: the Openship rows go, the containers
 *                          keep running and stay re-importable from their manifest.
 *   ?destroyOnSource=true → full teardown: stopped, removed and volumes wiped.
 *
 * The server row is deleted LAST and only if every workload actually left the control
 * plane. A failure returns 409 with per-workload results and the server intact, which
 * is both retryable and what keeps orphan GC able to reclaim anything left behind —
 * `reclaimOrphan` resolves its platform from the server row, so deleting that row
 * while orphans exist strands them permanently.
 */
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
  // Checked before any teardown so a refused removal never destroys a workload.
  if (existing.isLocal) {
    return c.json({ error: "This is the current host and can't be removed." }, 400);
  }

  const destroyOnSource = c.req.query("destroyOnSource") === "true";

  // Same coalesce the fleet chip and the preview use, so the set torn down here is
  // exactly the set the operator was shown.
  const bound = await repos.project
    .listActiveByServer(ctx.organizationId, id)
    .catch(() => [] as Awaited<ReturnType<typeof repos.project.listActiveByServer>>);

  // Dynamic import: project-teardown pulls in the mail/webmail install service, and
  // a static edge from the system module to that graph is a cycle waiting to happen.
  const { teardownProject } = await import("../projects/project-teardown");

  const results: {
    id: string;
    name: string;
    ok: boolean;
    orphaned?: number;
    error?: string;
  }[] = [];

  for (const p of bound) {
    // The control plane is refused by teardownProject anyway; skipping it here keeps
    // the operator's report honest instead of listing a guaranteed failure.
    if (p.appTemplateId === "openship") {
      results.push({
        id: p.id,
        name: p.name,
        ok: false,
        error: "The Openship control plane can't be torn down via the API.",
      });
      continue;
    }
    const r = await teardownProject(ctx, p.id, {
      // The operator confirmed a decommission by name; a queued deploy must not
      // veto it (it would just fail against a server that's going away).
      force: true,
      // The whole point of the default: drop the rows, leave the workload, its data
      // and its manifest so the box can be re-imported.
      recordOnly: !destroyOnSource,
      wipeVolumes: destroyOnSource,
      // NOT forceOrphan: an orphan recorded here can never be reclaimed once the
      // server row goes, so a stubborn resource must surface as a retryable failure
      // rather than a silent leak.
    }).catch((err: unknown) => ({
      ok: false,
      rowDeleted: false,
      unrecoverable: [{ step: "teardown", status: "failed" as const, error: safeErrorMessage(err) }],
      orphaned: [],
    }));

    results.push({
      id: p.id,
      name: p.name,
      // `rowDeleted`, not `ok`: the question this gates is "did the workload leave
      // the control plane", which is what makes deleting the server row safe.
      ok: r.rowDeleted,
      ...(r.orphaned.length > 0 ? { orphaned: r.orphaned.length } : {}),
      ...(r.rowDeleted && r.unrecoverable.length === 0
        ? {}
        : { error: r.unrecoverable[0]?.error ?? "Teardown failed" }),
    });
  }

  const failed = results.filter((r) => !r.ok);
  // An orphan means a resource we could not destroy and recorded for GC — and GC
  // needs this server row to reach it. Treat it as blocking so the operator retries
  // once the box answers, instead of inheriting an unreclaimable container.
  const stranded = results.filter((r) => r.ok && (r.orphaned ?? 0) > 0);

  if (failed.length > 0 || stranded.length > 0) {
    audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
      eventType: "server.removal.rejected",
      resourceType: "server",
      resourceId: id,
      after: {
        name: existing.name,
        destroyOnSource,
        workloadsRemoved: results.filter((r) => r.ok).length,
        workloadsFailed: failed.length,
        workloadsStranded: stranded.length,
      },
    });
    return c.json(
      {
        ok: false,
        code: "SERVER_WORKLOAD_TEARDOWN_FAILED",
        error:
          failed[0]?.error ??
          "Some resources could not be destroyed on the server and were recorded for cleanup — the server was kept so they can still be reclaimed.",
        // The server row survives, so the operator retries rather than inheriting a
        // fleet where some projects are gone and some point at nothing.
        serverRemoved: false,
        destroyOnSource,
        workloads: results,
      },
      409,
    );
  }

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
      // Which of the two removals this was, and what it took with it. The old
      // `unboundProjects` counted projects left pointing at a dead id — a state
      // that no longer exists, since every workload is now resolved either way.
      destroyOnSource,
      workloadsRemoved: results.length,
      workloadIds: results.map((r) => r.id),
    },
  });

  return c.json({
    ok: true,
    serverRemoved: true,
    destroyOnSource,
    workloads: results,
    removed: results.length,
  });
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
