import { db, schema, eq } from "@repo/db";

import { resolvesToLocalHost } from "./self-host";

let cachedBoxOrgId: string | null = null;

/**
 * The organization that OWNS this control-plane box: the founding admin's
 * personal org (`org_<founderId>`) — the same org self-server.ts registers the
 * isLocal "This Server" row in.
 *
 * Only this org may treat a loopback/self server row as the local host, which
 * resolves to `createHostExecutor()` + the mounted docker socket — i.e. code
 * execution on the control-plane host (DooD ≈ root). Without this gate, on a
 * multi-org self-hosted box any teammate's personal org could POST a
 * `sshHost: 127.0.0.1` server and mint itself a host-root deploy target
 * (ordinary members pass the `server` resource-type permission check).
 *
 * Memoized: the founding admin is created once and never changes. Null before
 * onboarding (no admin yet) — no deploys happen then anyway.
 */
export async function boxOwningOrgId(): Promise<string | null> {
  if (cachedBoxOrgId) return cachedBoxOrgId;
  const [admin] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.autoProvisioned, false))
    .orderBy(schema.user.createdAt)
    .limit(1);
  if (!admin?.id) return null;
  cachedBoxOrgId = `org_${admin.id}`;
  return cachedBoxOrgId;
}

type LocalServerRow = {
  isLocal?: boolean | null;
  sshHost?: string | null;
  sshPort?: number | null;
  sshJumpHost?: string | null;
  organizationId?: string | null;
};

/**
 * True when a `servers` row denotes THIS box and may be run on locally.
 *
 * An `isLocal` row is trusted — only the boot reconcile (founding org) or a
 * box-org-gated adopt/self-heal ever sets that flag. A row that merely
 * `resolvesToLocalHost` (loopback / SERVER_IP) is treated as local ONLY when it
 * belongs to the box-owning org, never a teammate's org.
 */
export async function isLocalHostRow(server: LocalServerRow): Promise<boolean> {
  if (server.isLocal) return true;
  if (!resolvesToLocalHost(server)) return false;
  const boxOrg = await boxOwningOrgId();
  return !!boxOrg && server.organizationId === boxOrg;
}
