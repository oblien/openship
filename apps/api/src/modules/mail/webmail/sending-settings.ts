import { customerAppAdmin, customerProjectIdSchema } from "./customer-app-admin";
import { CUSTOMER_WEBMAIL_PROJECT_HEADER, managedMailNamespacePattern } from "@repo/contracts/managed-mail";
import { isWebmailOnMailServer } from "@repo/contracts";
import { cloudRuntimeTarget } from "@repo/platform/engine/config/env";
import { patPrefix } from "@repo/platform/engine/lib/pat";
import { mailApiRelay, mailApiRelayAvailable } from "@repo/platform/engine/modules/mail/admin/api-relay";
import { AppError } from "@repo/core";
import { repos } from "@repo/db";
import { decrypt } from "@repo/platform/engine/lib/encryption";
import { resolveWebmailSummary } from "@repo/platform/engine/modules/mail/webmail/webmail-install.service";
import {
  initializeSharedDomains,
  assertTenantDomain,
} from "@repo/platform/engine/modules/mail/admin/tenant-domains";
import { enforceSharedImap } from "@repo/platform/engine/modules/mail/admin/shared-imap";
import { configureSharedRelay } from "@repo/platform/engine/modules/mail/admin/shared-relay";
import { workerTenant } from "../account-path";
import { getRequestContext } from "../../../lib/request-context";
import { permission } from "../../../lib/permission";
import type { Context } from "hono";
import { z } from "zod";

export const sendingSettingsSchema = z
  .object({
    namespace: z.string().regex(managedMailNamespacePattern),
    apiOrigin: z.literal(new URL(cloudRuntimeTarget.api).origin).optional(),
    keyId: z.string().min(1).max(64),
    key: z.string().min(1).max(4096),
  })
  .strict()
  .refine(settings => !settings.apiOrigin || !!patPrefix(settings.key));

async function authorizedWebmail(c: Context, serverId: string, requireLocal = false) {
  await permission.assert(getRequestContext(c), {
    resourceType: "mail_server",
    resourceId: serverId,
    action: "admin",
  });
  const ctx = getRequestContext(c);
  const record = await repos.mailServer.get(serverId);
  const customerProjectId = c.req.header(CUSTOMER_WEBMAIL_PROJECT_HEADER);
  if (customerProjectId !== undefined) {
    if (workerTenant(c) || ctx.principalKind !== "pat" || !ctx.sessionId.startsWith("pat:") ||
        !record || record.webmailProjectId || !customerProjectIdSchema.safeParse(customerProjectId).success)
      throw new AppError("Invalid dedicated Webmail assignment.", 403);
    await permission.assert(ctx, { resourceType: "server", resourceId: serverId, action: "admin" });
    const server = await repos.server.getInOrganization(serverId, ctx.organizationId);
    if (!server?.sshHost || server.workspaceId) throw new AppError("Dedicated mail requires a registered VM.", 409);
    return customerAppAdmin(serverId, customerProjectId);
  }
  if (!record?.webmailProjectId) throw new AppError("Deploy and link Openship Webmail first.", 409);
  await permission.assert(ctx, {
    resourceType: "project",
    resourceId: record.webmailProjectId,
    action: "admin",
  });
  const webmail = await resolveWebmailSummary(ctx.organizationId, record);
  if (!webmail?.installed || !webmail.url || webmail.projectId !== record.webmailProjectId)
    throw new AppError("The linked webmail must be running with its verified hostname.", 409);
  if (requireLocal && !isWebmailOnMailServer(webmail, serverId))
    throw new AppError("Dedicated AI requires webmail on the dedicated mail VM.", 409);
  const services = await repos.service.listByProject(record.webmailProjectId);
  const service = services.find((row) => row.name === "webmail");
  if (!service) throw new AppError("The linked app has no webmail service.", 409);
  const secrets = await repos.project.getEnvMap(record.webmailProjectId, "production", service.id);
  if (!secrets.OPENSHIP_SENDING_ADMIN_TOKEN)
    throw new AppError(
      "Redeploy the linked webmail to install its sending configuration token.",
      409,
    );
  const url = new URL(webmail.url);
  if (url.protocol !== "https:") throw new AppError("Managed webmail requires HTTPS.", 409);
  const token = decrypt(secrets.OPENSHIP_SENDING_ADMIN_TOKEN);
  return async <T>(path: string, schema: z.ZodType<T>, body?: object): Promise<T> => {
    const unavailable = () => new AppError(
      "The linked webmail could not confirm its managed sending configuration.", 502,
    );
    const response = await fetch(new URL(path, url), {
      method: body ? "PUT" : "GET",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: {
        "content-type": "application/json",
        "x-openship-sending-token": token,
      },
      body: body ? JSON.stringify(body) : undefined,
    }).catch(() => { throw unavailable(); });
    if (response.ok) {
      const result = schema.safeParse(await response.json().catch(() => { throw unavailable(); }));
      if (result.success) return result.data;
    }
    throw unavailable();
  };
}

export const hostingSchema = z.union([
  z.object({ namespace: sendingSettingsSchema.shape.namespace, imapHost: z.hostname(), dedicated: z.literal(true), customerProjectId: customerProjectIdSchema }).strict(),
  z.object({ namespace: sendingSettingsSchema.shape.namespace, imapHost: z.hostname(), dedicated: z.literal(true).optional() }).strict(),
  z.object({ shared: z.literal(true), imapHost: z.hostname() }).strict(),
]);
export async function bindWebmailHosting(
  c: Context,
  serverId: string,
  input: z.infer<typeof hostingSchema>,
) {
  const { customerProjectId, ...binding } = { customerProjectId: undefined as string | undefined, ...input };
  if (c.req.header(CUSTOMER_WEBMAIL_PROJECT_HEADER) !== customerProjectId)
    throw new AppError("Invalid dedicated Webmail binding.", 409);
  const request = await authorizedWebmail(c, serverId, "dedicated" in input && input.dedicated);
  if (!await mailApiRelayAvailable(serverId)) return { bound: false, apiRelay: false };
  if ("shared" in input)
    await initializeSharedDomains(serverId, input.imapHost.replace(/^mail\./, ""));
  const result = await request("/admin/hosting", z.object({ bound: z.boolean() }), binding);
  if (result.bound && "shared" in input) {
    await enforceSharedImap(serverId);
  }
  if (result.bound) await configureSharedRelay(serverId, undefined, "namespace" in input ? input.namespace : undefined);
  return { ...result, apiRelay: true };
}

export async function linkedWebmailSending(
  c: Context,
  serverId: string,
  domain: string,
  settings?: z.infer<typeof sendingSettingsSchema> | { apiOrigin: string; keyId: string; key: string },
) {
  const path = "/admin/sending/" + encodeURIComponent(z.hostname().parse(domain));
  const tenant = workerTenant(c);
  const request = await authorizedWebmail(c, serverId);
  if (tenant) {
    await assertTenantDomain(serverId, tenant, domain);
    if (settings && (!("namespace" in settings) || settings.namespace !== tenant))
      throw new AppError("Invalid sending namespace.", 409);
  }
  if (settings) {
    if ("namespace" in settings && patPrefix(settings.key)) {
      const apiOrigin = new URL(cloudRuntimeTarget.api).origin;
      const authority = { namespace: settings.namespace, apiOrigin };
      // Verify ownership of the Postfix route before updating either transport.
      await mailApiRelay(serverId, domain, authority);
      const confirmed = await request(path, z.object({ configured: z.literal(true) }), { ...settings, apiOrigin });
      await mailApiRelay(serverId, domain, authority, { keyId: settings.keyId, key: settings.key });
      return confirmed;
    }
    if (tenant) await configureSharedRelay(serverId, { domain, namespace: tenant, key: settings.key });
    return request(path, z.object({ configured: z.literal(true) }), settings);
  }
  const result = await request(
    path,
    z.object({
      sending: z.object({ keyId: z.string(), namespace: z.string().optional(), apiOrigin: z.string().optional() }).nullable(),
    }),
  );
  if (result.sending?.apiOrigin && result.sending.namespace) {
    if (tenant && tenant !== result.sending.namespace) throw new AppError("Mail domain binding changed.", 409);
    const relay = await mailApiRelay(serverId, domain, {
      apiOrigin: new URL(cloudRuntimeTarget.api).origin, namespace: result.sending.namespace,
    });
    return { sending: { ...result.sending, relayKeyId: relay?.keyId } };
  }
  return result;
}
