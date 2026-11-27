import { mailDatabaseTenant, reserveAsMailOperator } from "../tenant-session";
import { validateMailDomain } from "../mail-domain";
import { AppError } from "@repo/core";
import { execute, q, queryOne } from "./psql-runner";

/** Keep the reservation after deletion. Queued messages, soft-deleted Maildirs
 * and user preferences can outlive a domain row. Reassignments require cleanup. */
export async function initializeSharedDomains(serverId: string, primary: string) {
  await execute(
    serverId,
    `CREATE TABLE IF NOT EXISTS openship_domain_owner (
    domain text PRIMARY KEY, namespace text NOT NULL
  )`,
  );
  const unowned = await queryOne(
    serverId,
    `SELECT d.domain FROM domain d
    LEFT JOIN openship_domain_owner o ON o.domain = d.domain
    WHERE o.domain IS NULL AND d.domain <> ${q(primary)} LIMIT 1`,
  );
  if (unowned) throw new AppError("The mail host contains unassigned domains.", 409);
}

export function tenantDomainsSql(namespace: string) {
  return `SELECT domain FROM openship_domain_owner WHERE namespace = ${q(namespace)}`;
}

export function ownedDomain(namespace?: string) {
  return namespace !== undefined ? ` AND domain IN (${tenantDomainsSql(namespace)})` : "";
}

/** Acquire a shared lock on the live domain until the write commits. */
export function lockTenantDomainSql(domain: string, namespace: string) {
  return "DO " + q(`BEGIN
    PERFORM 1 FROM domain d JOIN openship_domain_owner o ON o.domain = d.domain
    WHERE d.domain = ${q(domain)} AND o.namespace = ${q(namespace)} FOR SHARE OF d;
    IF NOT FOUND THEN RAISE EXCEPTION 'Mail domain ownership changed'; END IF;
  END`);
}

export async function assertTenantDomain(serverId: string, namespace: string, domain: string) {
  const exists = await queryOne(
    serverId,
    `SELECT domain FROM domain WHERE domain = ${q(domain)}
    AND domain IN (${tenantDomainsSql(namespace)})`,
  );
  if (!exists) throw new AppError("Mail resource not found.", 404, "MAIL_NOT_FOUND");
}

/** Call only after the service-specific ownership TXT has been verified. A
 * reservation survives deletion, so a failed setup can be retried by its owner. */
export async function reserveVerifiedMailDomain(server: string, namespace: string, name: string) {
  validateMailDomain(name);
  if (mailDatabaseTenant() !== namespace) throw new AppError("Invalid tenant reservation.", 403);
  const domain = name.toLowerCase();
  await reserveAsMailOperator(() => execute(server, `INSERT INTO public.openship_domain_owner (domain, namespace)
    SELECT ${q(domain)}, ${q(namespace)} WHERE NOT EXISTS (SELECT FROM public.domain WHERE domain = ${q(domain)})
    ON CONFLICT (domain) DO NOTHING`));
  if (!await queryOne(server, `SELECT domain FROM openship_domain_owner
    WHERE domain = ${q(domain)} AND namespace = ${q(namespace)}`))
    throw new AppError("The mail domain is unavailable.", 409);
}
