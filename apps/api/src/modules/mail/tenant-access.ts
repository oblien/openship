import { createHmac } from "node:crypto";
import { z } from "zod";
import { repos } from "@repo/db";
import { hashPatToken } from "@repo/platform/engine/lib/pat";
import { createProvisionLock } from "@repo/platform/engine/lib/provision-lock";
import { parseBearerToken } from "../../lib/bearer";
import { verifyMailDomainOwnership } from "./domain-proof";
import { validateMailDomain } from "@repo/platform/engine/modules/mail/mail-domain";
import {
  MAIL_SERVICE_HEADER,
  MAIL_TENANT_TOKEN_PREFIX,
  managedMailNamespacePattern,
} from "@repo/contracts/managed-mail";
import { mailRequestDomains, readMailRequestBody, workerTenant } from "./account-path";
import { bindWebmailHosting } from "./webmail/sending-settings";
import type { Context } from "hono";
import { AppError } from "@repo/core";
import { ensureTenantDatabase } from "@repo/platform/engine/modules/mail/admin/tenant-database";
import { assertTenantDomain, reserveVerifiedMailDomain } from "@repo/platform/engine/modules/mail/admin/tenant-domains";
import { getAlias } from "./admin/aliases.service";
import { getRequestContext } from "../../lib/request-context";
import { permission } from "../../lib/permission";

const binding = z
  .object({
    namespace: z.string().regex(managedMailNamespacePattern),
    serviceId: z.string().regex(/^managed-mail-[a-zA-Z0-9_-]{1,96}$/),
    imapHost: z.hostname(),
  })
  .strict();

export async function issueTenantAccess(c: Context) {
  const serverId = c.req.param("serverId")!;
  await permission.assert(getRequestContext(c), {
    resourceType: "mail_server",
    resourceId: serverId,
    action: "admin",
  });
  const ctx = getRequestContext(c);
  const parent = parseBearerToken(c);
  if (ctx.principalKind !== "pat" || !ctx.sessionId.startsWith("pat:") || !parent)
    throw new AppError("Worker enrollment requires an operator access token.", 403);
  const input = binding.safeParse(await readMailRequestBody(c));
  if (!input.success) throw new AppError("Invalid shared mail binding.", 400);
  const { namespace, serviceId, imapHost } = input.data;
  const token =
    MAIL_TENANT_TOKEN_PREFIX +
    createHmac("sha256", parent)
      .update(JSON.stringify(["openship/shared-mail/v1", serverId, namespace, serviceId]))
      .digest("base64url");
  const tokenHash = hashPatToken(token);
  await createProvisionLock("mail:tenant-enrollment:" + serverId).run(async () => {
    if (await repos.managedMail.tenantAccess(tokenHash)) {
      await ensureTenantDatabase(serverId, namespace);
      return;
    }
    const hosted = await bindWebmailHosting(c, serverId, { shared: true, imapHost });
    if (!hosted.bound)
      throw new AppError("The host is assigned to another mail installation.", 409);
    await ensureTenantDatabase(serverId, namespace);
    const bound = await repos.managedMail.bindTenantAccess({
      serverId,
      namespace,
      serviceId,
      tokenHash,
      organizationId: ctx.organizationId,
      parentId: ctx.sessionId.slice(4),
    });
    if (!bound) throw new AppError("The tenant is assigned to another mail service.", 409);
  });
  c.header("Cache-Control", "no-store");
  return c.json({ token });
}

/** Called only on the owning worker, after route authentication. A tenant
 * qualifier always narrows an existing server grant. Unqualified worker
 * requests retain the self-hosted operator's ordinary admin surface. */
export async function authorizeTenantAccount(c: Context, path: string) {
  const namespace = workerTenant(c);
  if (!namespace) return;
  const server = c.req.param("serverId")!;
  await permission.assert(getRequestContext(c), {
    resourceType: "mail_server",
    resourceId: server,
    action: "admin",
  });
  const method = c.req.method;
  if (path === "/admin/:serverId/domains" && method === "POST") {
    const { domain } = await c.req.json();
    validateMailDomain(domain);
    await verifyMailDomainOwnership(c.req.header(MAIL_SERVICE_HEADER)!, domain);
    await reserveVerifiedMailDomain(server, namespace, domain);
    return;
  }
  if (
    path === "/admin/:serverId/domains" ||
    (method === "GET" &&
      ["/admin/:serverId/stats", "/admin/:serverId/domains-dns/pending"].includes(path))
  )
    return;
  if (path.endsWith("/aliases/:id")) {
    const id = Number(c.req.param("id"));
    const alias = Number.isSafeInteger(id) ? await getAlias(server, id, namespace) : null;
    if (!alias) throw new AppError("Mail resource not found.", 404);
    await assertTenantDomain(server, namespace, alias.domain);
    return;
  }
  const body = method === "POST" || method === "PATCH" ? await readMailRequestBody(c) : {};
  const domains = mailRequestDomains(c, body);
  if (!domains[0] || new Set(domains).size !== 1)
    throw new AppError("Mail resource not found.", 404);
  await assertTenantDomain(server, namespace, domains[0]);
  if (path.endsWith("/aliases") && method === "POST") {
    // Automatic external forwards have no authenticated sending identity.
    const destination = String(body.destination ?? "")
      .trim()
      .toLowerCase()
      .split("@")[1];
    if (!destination) throw new AppError("Invalid forwarding address.", 400);
    await assertTenantDomain(server, namespace, destination);
  }
}
