/**
 * Backup destinations — per-user CRUD + preflight.
 *
 * Credentials are encrypted with the existing `enc1:` envelope from
 * lib/credential-encryption.ts. Serialized destinations NEVER contain
 * ciphertext or plaintext — only `hasCredentials` flags and metadata.
 *
 * Preflight calls the destination adapter's `preflight()` (writes +
 * reads + deletes a probe object). On success we stamp lastVerifiedAt;
 * on failure we record the error so the dashboard can surface it.
 */

import { repos, type BackupDestination } from "@repo/db";
import { type DestinationKind, type BackupDestinationRow } from "@repo/adapters";
import crypto from "node:crypto";
import path from "node:path";
import { realpath } from "node:fs/promises";
import { encryptSecretField } from "../../lib/credential-encryption";
import { assertResourceInOrg } from "../../lib/controller-helpers";
import type { RequestContext } from "../../lib/request-context";
import { env } from "../../config/env";
import { assertPublicUrl, assertPublicHost } from "../../lib/ssrf-guard";
import { toAdapterRow, hydrateServerAdapterRow } from "./hydrate-server";
import { safeErrorMessage, type ConnectivityCode } from "@repo/core";
import { runConnectivityCheck } from "../../lib/connectivity";
import "../../lib/connectivity-checks"; // registers the backup-destination check

/**
 * Resolve + sandbox a local destination endpoint. Refuses any path
 * that escapes `BACKUP_LOCAL_ROOT` or sits inside known system
 * directories. Symlinks are resolved before the comparison so an
 * attacker can't slip a symlink-into-/etc past the check.
 *
 * The realpath() will fail if the endpoint doesn't exist yet — we
 * fall back to resolving the parent + appending the leaf, which is
 * sufficient because the destination's writes go through fs.mkdir
 * later and a deceptive non-existent path can't outflank the check.
 */
const LOCAL_DEST_DENY = [
  "/etc",
  "/proc",
  "/sys",
  "/dev",
  "/root",
  "/var/lib/postgresql",
  "/var/lib/docker",
  "/var/lib/openship",
  "/boot",
];

async function validateLocalEndpoint(endpoint: string): Promise<void> {
  if (env.CLOUD_MODE) {
    throw new Error("Local destinations are disabled in cloud mode");
  }
  if (!env.BACKUP_ALLOW_LOCAL_DESTINATION) {
    throw new Error(
      "Local destinations are disabled. Set BACKUP_ALLOW_LOCAL_DESTINATION=true and BACKUP_LOCAL_ROOT to enable.",
    );
  }
  if (!path.isAbsolute(endpoint)) {
    throw new Error("Local destination path must be absolute");
  }
  const root = path.resolve(env.BACKUP_LOCAL_ROOT);
  const requested = path.resolve(endpoint);

  // Reject any path that lands inside a denied system directory, even
  // before we resolve symlinks (catches the obvious case + makes the
  // error message useful).
  for (const denied of LOCAL_DEST_DENY) {
    if (requested === denied || requested.startsWith(denied + path.sep)) {
      throw new Error(
        `Local destination path is inside a protected directory (${denied})`,
      );
    }
  }

  // Resolve symlinks where possible. If the leaf doesn't exist yet,
  // resolve the closest existing ancestor and append the remainder.
  let resolved = requested;
  try {
    resolved = await realpath(requested);
  } catch {
    let parent = requested;
    while (parent !== path.dirname(parent)) {
      parent = path.dirname(parent);
      try {
        const real = await realpath(parent);
        resolved = path.join(real, requested.slice(parent.length));
        break;
      } catch {
        // keep walking up
      }
    }
  }

  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(
      `Local destination must be inside BACKUP_LOCAL_ROOT (${root})`,
    );
  }
}

// ─── Public shapes ───────────────────────────────────────────────────────────

export interface CreateDestinationInput {
  name: string;
  kind: DestinationKind;
  endpoint?: string | null;
  region?: string | null;
  bucket?: string | null;
  pathPrefix?: string | null;
  sshHost?: string | null;
  sshPort?: number | null;
  sshUser?: string | null;
  /** When kind="openship_server", the user's servers.id to reuse. */
  serverId?: string | null;
  accessKeyId?: string | null;
  secretAccessKey?: string | null;
  sftpPassword?: string | null;
  sftpPrivateKey?: string | null;
  sftpKeyPassphrase?: string | null;
  isDefault?: boolean;
}

export interface UpdateDestinationInput {
  name?: string;
  endpoint?: string | null;
  region?: string | null;
  bucket?: string | null;
  pathPrefix?: string | null;
  sshHost?: string | null;
  sshPort?: number | null;
  sshUser?: string | null;
  /** Pass undefined to leave unchanged; null to clear; string to replace. */
  accessKeyId?: string | null;
  secretAccessKey?: string | null;
  sftpPassword?: string | null;
  sftpPrivateKey?: string | null;
  sftpKeyPassphrase?: string | null;
  isDefault?: boolean;
}

/** Safe-to-display destination shape — strips every ciphertext, exposes
 *  only `hasX` flags so the UI can render "credentials configured"
 *  without ever seeing the secret. */
export interface SerializedDestination {
  id: string;
  name: string;
  kind: string;
  endpoint: string | null;
  region: string | null;
  bucket: string | null;
  pathPrefix: string | null;
  sshHost: string | null;
  sshPort: number | null;
  sshUser: string | null;
  serverId: string | null;
  hasAccessKeyId: boolean;
  hasSecretAccessKey: boolean;
  hasSftpPassword: boolean;
  hasSftpPrivateKey: boolean;
  hasSftpKeyPassphrase: boolean;
  lastVerifiedAt: string | null;
  lastVerifyError: string | null;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
  /** Storage rollup (bytes stored, backup count, last run). Populated by the
   *  list endpoint; null on single-destination fetches. */
  stats: { storedBytes: number; runCount: number; lastRunAt: string | null } | null;
}

export function serializeDestination(
  row: BackupDestination,
  stats: SerializedDestination["stats"] = null,
): SerializedDestination {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    endpoint: row.endpoint,
    region: row.region,
    bucket: row.bucket,
    pathPrefix: row.pathPrefix,
    sshHost: row.sshHost,
    sshPort: row.sshPort,
    sshUser: row.sshUser,
    serverId: row.serverId,
    hasAccessKeyId: !!row.accessKeyIdEnc,
    hasSecretAccessKey: !!row.secretAccessKeyEnc,
    hasSftpPassword: !!row.sftpPasswordEnc,
    hasSftpPrivateKey: !!row.sftpPrivateKeyEnc,
    hasSftpKeyPassphrase: !!row.sftpKeyPassphraseEnc,
    lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null,
    lastVerifyError: row.lastVerifyError,
    isDefault: row.isDefault,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    stats,
  };
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

export async function listDestinations(ctx: RequestContext): Promise<SerializedDestination[]> {
  const [rows, stats] = await Promise.all([
    repos.backupDestination.listByOrganization(ctx.organizationId),
    repos.backupRun.statsByDestination(ctx.organizationId),
  ]);
  const statsById = new Map(stats.filter((s) => s.destinationId).map((s) => [s.destinationId!, s]));
  return rows.map((row) => {
    const s = statsById.get(row.id);
    return serializeDestination(
      row,
      s ? { storedBytes: s.storedBytes, runCount: s.runCount, lastRunAt: s.lastRunAt?.toISOString() ?? null } : null,
    );
  });
}

export async function getDestination(
  ctx: RequestContext,
  id: string,
): Promise<SerializedDestination> {
  const row = await repos.backupDestination.findById(id);
  assertResourceInOrg(row, "Destination", ctx.organizationId, id);
  return serializeDestination(row);
}

/** One policy that targets a destination, resolved for the detail page's
 *  "used by" view. */
export interface DestinationUsagePolicy {
  policyId: string;
  sourceKind: string;
  projectId: string | null;
  projectName: string | null;
  projectSlug: string | null;
  serviceId: string | null;
  serviceName: string | null;
  mailServerId: string | null;
  payloadKind: string;
  cronExpression: string | null;
  enabled: boolean;
  lastRun:
    | { id: string; status: string; startedAt: string; finishedAt: string | null; bytesTransferred: number | null }
    | null;
}

export interface DestinationUsage {
  destination: SerializedDestination;
  policies: DestinationUsagePolicy[];
}

/**
 * A destination plus everything that backs up to it: its storage rollup and the
 * policies (project/service or mail-server) targeting it, each with its last
 * run. Powers the destination detail page — the "what owns this" view.
 */
export async function getDestinationUsage(ctx: RequestContext, id: string): Promise<DestinationUsage> {
  const row = await repos.backupDestination.findById(id);
  assertResourceInOrg(row, "Destination", ctx.organizationId, id);

  const [stats, policies] = await Promise.all([
    repos.backupRun.statsByDestination(ctx.organizationId),
    repos.backupPolicy.listByDestination(id),
  ]);
  const st = stats.find((s) => s.destinationId === id) ?? null;
  const destination = serializeDestination(
    row,
    st ? { storedBytes: st.storedBytes, runCount: st.runCount, lastRunAt: st.lastRunAt?.toISOString() ?? null } : null,
  );

  const projectCache = new Map<string, Awaited<ReturnType<typeof repos.project.findById>>>();
  const serviceCache = new Map<string, Awaited<ReturnType<typeof repos.service.findById>>>();
  const out: DestinationUsagePolicy[] = [];
  for (const p of policies) {
    let project: Awaited<ReturnType<typeof repos.project.findById>> = undefined;
    if (p.projectId) {
      if (!projectCache.has(p.projectId)) projectCache.set(p.projectId, await repos.project.findById(p.projectId));
      project = projectCache.get(p.projectId);
    }
    let service: Awaited<ReturnType<typeof repos.service.findById>> = undefined;
    if (p.serviceId) {
      if (!serviceCache.has(p.serviceId)) serviceCache.set(p.serviceId, await repos.service.findById(p.serviceId));
      service = serviceCache.get(p.serviceId);
    }
    const lastRun = await repos.backupRun.latestByPolicy(p.id);
    out.push({
      policyId: p.id,
      sourceKind: p.sourceKind,
      projectId: p.projectId,
      projectName: project?.name ?? null,
      projectSlug: project?.slug ?? null,
      serviceId: p.serviceId,
      serviceName: service?.name ?? null,
      mailServerId: p.mailServerId,
      payloadKind: p.payloadKind,
      cronExpression: p.cronExpression,
      enabled: p.enabled,
      lastRun: lastRun
        ? {
            id: lastRun.id,
            status: lastRun.status,
            startedAt: lastRun.startedAt.toISOString(),
            finishedAt: lastRun.finishedAt?.toISOString() ?? null,
            bytesTransferred: lastRun.bytesTransferred,
          }
        : null,
    });
  }
  return { destination, policies: out };
}

export async function createDestination(
  ctx: RequestContext,
  input: CreateDestinationInput,
): Promise<SerializedDestination> {
  await validateInput(input);

  // Ownership check for openship_server: the serverId arrives from the
  // request body and MUST belong to the calling org. Without this
  // check, an attacker could create a destination using a victim's
  // server row and SSH-impersonate them.
  if (input.kind === "openship_server") {
    if (!input.serverId) {
      throw new Error("openship_server destinations require a serverId");
    }
    const server = await repos.server.get(input.serverId);
    if (!server) {
      throw new Error("Server not accessible");
    }
    // Cross-org check when the server has an org stamp; rows without one fall through.
    if (
      "organizationId" in server &&
      (server as { organizationId?: string | null }).organizationId &&
      (server as { organizationId?: string | null }).organizationId !== ctx.organizationId
    ) {
      throw new Error("Server not accessible");
    }
  }

  // Uniqueness check (DB has a partial unique index but we want a clean
  // error message before hitting the constraint).
  const existing = await repos.backupDestination.findByNameInOrganization(
    ctx.organizationId,
    input.name,
  );
  if (existing) {
    throw new Error(`A destination named "${input.name}" already exists`);
  }

  const id = `bkd_${crypto.randomUUID()}`;
  const row = await repos.backupDestination.create({
    id,
    organizationId: ctx.organizationId,
    name: input.name,
    kind: input.kind,
    endpoint: input.endpoint ?? null,
    region: input.region ?? null,
    bucket: input.bucket ?? null,
    pathPrefix: input.pathPrefix ?? null,
    sshHost: input.sshHost ?? null,
    sshPort: input.sshPort ?? null,
    sshUser: input.sshUser ?? null,
    serverId: input.serverId ?? null,
    accessKeyIdEnc: encryptSecretField(input.accessKeyId ?? null),
    secretAccessKeyEnc: encryptSecretField(input.secretAccessKey ?? null),
    sftpPasswordEnc: encryptSecretField(input.sftpPassword ?? null),
    sftpPrivateKeyEnc: encryptSecretField(input.sftpPrivateKey ?? null),
    sftpKeyPassphraseEnc: encryptSecretField(input.sftpKeyPassphrase ?? null),
    isDefault: input.isDefault ?? false,
  });
  return serializeDestination(row);
}

export async function updateDestination(
  ctx: RequestContext,
  id: string,
  patch: UpdateDestinationInput,
): Promise<SerializedDestination> {
  const existing = await repos.backupDestination.findById(id);
  assertResourceInOrg(existing, "Destination", ctx.organizationId, id);

  // Re-validate on PATCH: for the `local` kind, every endpoint change
  // must clear validateLocalEndpoint() so the path stays inside BACKUP_LOCAL_ROOT.
  if (patch.name !== undefined) {
    if (!patch.name.trim()) throw new Error("Name is required");
    if (patch.name.length > 80) throw new Error("Name is too long (max 80 chars)");
  }
  if (existing.kind === "local" && patch.endpoint !== undefined) {
    if (!patch.endpoint) {
      throw new Error("Local destinations require an absolute filesystem path");
    }
    await validateLocalEndpoint(patch.endpoint);
  }
  // SSRF (CLOUD_MODE): a PATCH can repoint endpoint/sshHost at an internal target,
  // bypassing the create-time guard. Re-guard the EFFECTIVE (merged) values.
  await assertDestinationTargetPublic({
    kind: existing.kind,
    endpoint: patch.endpoint !== undefined ? patch.endpoint : existing.endpoint,
    sshHost: patch.sshHost !== undefined ? patch.sshHost : existing.sshHost,
  });

  // Encrypt only the credential fields that are explicitly set in the
  // patch. undefined = leave unchanged; null = clear; string = replace.
  const update: Parameters<typeof repos.backupDestination.update>[1] = {};
  if (patch.name !== undefined) update.name = patch.name;
  if (patch.endpoint !== undefined) update.endpoint = patch.endpoint;
  if (patch.region !== undefined) update.region = patch.region;
  if (patch.bucket !== undefined) update.bucket = patch.bucket;
  if (patch.pathPrefix !== undefined) update.pathPrefix = patch.pathPrefix;
  if (patch.sshHost !== undefined) update.sshHost = patch.sshHost;
  if (patch.sshPort !== undefined) update.sshPort = patch.sshPort;
  if (patch.sshUser !== undefined) update.sshUser = patch.sshUser;
  if (patch.isDefault !== undefined) update.isDefault = patch.isDefault;

  if (patch.accessKeyId !== undefined) {
    update.accessKeyIdEnc = encryptSecretField(patch.accessKeyId);
  }
  if (patch.secretAccessKey !== undefined) {
    update.secretAccessKeyEnc = encryptSecretField(patch.secretAccessKey);
  }
  if (patch.sftpPassword !== undefined) {
    update.sftpPasswordEnc = encryptSecretField(patch.sftpPassword);
  }
  if (patch.sftpPrivateKey !== undefined) {
    update.sftpPrivateKeyEnc = encryptSecretField(patch.sftpPrivateKey);
  }
  if (patch.sftpKeyPassphrase !== undefined) {
    update.sftpKeyPassphraseEnc = encryptSecretField(patch.sftpKeyPassphrase);
  }

  const row = await repos.backupDestination.update(id, update);
  if (!row) throw new Error("Destination not found");
  return serializeDestination(row);
}

export async function deleteDestination(ctx: RequestContext, id: string): Promise<void> {
  const row = await repos.backupDestination.findById(id);
  assertResourceInOrg(row, "Destination", ctx.organizationId, id);

  const result = await repos.backupDestination.softDelete(id);
  if (!result.ok) {
    throw new Error(result.reason);
  }
}

// ─── Preflight ───────────────────────────────────────────────────────────────

export async function preflightDestination(
  ctx: RequestContext,
  id: string,
): Promise<{ ok: boolean; reason?: string; code?: ConnectivityCode }> {
  const row = await repos.backupDestination.findById(id);
  assertResourceInOrg(row, "Destination", ctx.organizationId, id);

  try {
    // Local destinations: run the same disabled/sandbox gate as create/update so a
    // disabled instance or an out-of-root path returns the clean policy message
    // instead of a raw fs error (ENOENT/EACCES) leaking from the adapter's mkdir.
    if (row.kind === "local") await validateLocalEndpoint(row.endpoint ?? "");
    // SSRF (CLOUD_MODE): the saved endpoint/sshHost may have been PATCHed to an
    // internal target after create — re-guard s3/sftp before dialing.
    await assertDestinationTargetPublic({ kind: row.kind, endpoint: row.endpoint, sshHost: row.sshHost });
    const adapterRow = await toAdapterRow(row);
    const result = await runConnectivityCheck("backup-destination", adapterRow);
    await repos.backupDestination.setLastVerified(
      id,
      result.ok,
      result.ok ? undefined : result.message,
    );
    return result.ok
      ? { ok: true, code: result.code }
      : { ok: false, reason: result.message, code: result.code };
  } catch (err) {
    const reason = safeErrorMessage(err);
    await repos.backupDestination.setLastVerified(id, false, reason);
    return { ok: false, reason };
  }
}

/**
 * Preflight an UNSAVED destination — the "Test connection" button in the create/
 * edit modal. Builds an ephemeral adapter row from the submitted input (nothing
 * is persisted) and runs the same probe as {@link preflightDestination}. When
 * editing (`existingId` set), secret fields left blank fall back to the stored
 * ciphertext so a user can test without re-typing credentials.
 */
export async function preflightDraft(
  ctx: RequestContext,
  input: CreateDestinationInput,
  existingId?: string,
): Promise<{ ok: boolean; reason?: string; code?: ConnectivityCode }> {
  let stored: BackupDestination | null = null;
  if (existingId) {
    stored = (await repos.backupDestination.findById(existingId)) ?? null;
    assertResourceInOrg(stored, "Destination", ctx.organizationId, existingId);
  }

  // SaaS SSRF guard — before the connectivity check touches the network.
  await assertDestinationTargetPublic(input);

  // Non-secret: prefer the submitted value, else the stored one. Blank ("") is
  // treated as "not provided" so it never blanks a stored field mid-test.
  const val = (v: string | null | undefined, kept: string | null): string | null =>
    v != null && v !== "" ? v : kept;
  // Secret: a typed value is encrypted now; blank keeps the stored ciphertext.
  const enc = (v: string | null | undefined, kept: string | null): string | null =>
    v ? encryptSecretField(v) : kept;

  let adapterRow: BackupDestinationRow;
  try {
    if (input.kind === "openship_server") {
      const serverId = input.serverId ?? stored?.serverId ?? null;
      if (!serverId) return { ok: false, reason: "Select a server to test" };
      adapterRow = await hydrateServerAdapterRow({
        id: existingId ?? "bkd_draft",
        organizationId: ctx.organizationId,
        name: input.name || "draft",
        pathPrefix: val(input.pathPrefix, stored?.pathPrefix ?? null),
        serverId,
      });
    } else {
      adapterRow = {
        id: existingId ?? "bkd_draft",
        organizationId: ctx.organizationId,
        name: input.name || "draft",
        kind: input.kind,
        endpoint: val(input.endpoint, stored?.endpoint ?? null),
        region: val(input.region, stored?.region ?? null),
        bucket: val(input.bucket, stored?.bucket ?? null),
        pathPrefix: val(input.pathPrefix, stored?.pathPrefix ?? null),
        sshHost: val(input.sshHost, stored?.sshHost ?? null),
        sshPort: input.sshPort ?? stored?.sshPort ?? null,
        sshUser: val(input.sshUser, stored?.sshUser ?? null),
        serverId: null,
        accessKeyIdEnc: enc(input.accessKeyId, stored?.accessKeyIdEnc ?? null),
        secretAccessKeyEnc: enc(input.secretAccessKey, stored?.secretAccessKeyEnc ?? null),
        sftpPasswordEnc: enc(input.sftpPassword, stored?.sftpPasswordEnc ?? null),
        sftpPrivateKeyEnc: enc(input.sftpPrivateKey, stored?.sftpPrivateKeyEnc ?? null),
        sftpKeyPassphraseEnc: enc(input.sftpKeyPassphrase, stored?.sftpKeyPassphraseEnc ?? null),
      };
    }
    // Local destinations: gate on the disabled/sandbox policy first (same as
    // create/update) so "Test connection" surfaces the clean message rather than a
    // raw mkdir ENOENT/EACCES from the adapter.
    if (adapterRow.kind === "local") await validateLocalEndpoint(adapterRow.endpoint ?? "");
    const result = await runConnectivityCheck("backup-destination", adapterRow);
    return result.ok
      ? { ok: true, code: result.code }
      : { ok: false, reason: result.message, code: result.code };
  } catch (err) {
    return { ok: false, reason: safeErrorMessage(err) };
  }
}

// ─── Validation ──────────────────────────────────────────────────────────────

/**
 * SaaS SSRF guard: an authed org member must not aim a destination's
 * connectivity check / upload at the control plane's own network (loopback /
 * RFC1918 / 169.254 metadata / …). Self-hosted operators legitimately back up
 * to their LAN, so this only applies on the multi-tenant SaaS (CLOUD_MODE).
 */
async function assertDestinationTargetPublic(input: {
  kind: string;
  endpoint?: string | null;
  sshHost?: string | null;
}): Promise<void> {
  if (!env.CLOUD_MODE) return;
  if (input.kind === "s3_compatible" && input.endpoint) {
    await assertPublicUrl(input.endpoint, { allowHttp: true });
  } else if (input.kind === "sftp" && input.sshHost) {
    await assertPublicHost(input.sshHost);
  }
}

async function validateInput(input: CreateDestinationInput): Promise<void> {
  if (!input.name?.trim()) throw new Error("Name is required");
  if (input.name.length > 80) throw new Error("Name is too long (max 80 chars)");
  await assertDestinationTargetPublic(input);

  switch (input.kind) {
    case "s3_compatible":
      if (!input.bucket) throw new Error("S3 destinations require a bucket");
      if (!input.accessKeyId || !input.secretAccessKey) {
        throw new Error("S3 destinations require access credentials");
      }
      break;
    case "sftp":
      if (!input.sshHost) throw new Error("SFTP destinations require sshHost");
      if (!input.sshUser) throw new Error("SFTP destinations require sshUser");
      if (!input.sftpPassword && !input.sftpPrivateKey) {
        throw new Error("SFTP destinations require a password or private key");
      }
      break;
    case "openship_server":
      if (!input.serverId) {
        throw new Error("openship_server destinations require a serverId");
      }
      break;
    case "local":
      if (!input.endpoint) {
        throw new Error("Local destinations require an absolute filesystem path");
      }
      await validateLocalEndpoint(input.endpoint);
      break;
    case "http_upload":
      throw new Error("http_upload destinations are not yet supported");
    default:
      throw new Error(`Unknown destination kind: ${String(input.kind)}`);
  }
}
