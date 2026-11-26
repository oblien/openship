import {
  previewMailChange,
  confirmMailChange,
  mailChangeStatus,
  cancelMailChange,
} from "@repo/platform/engine/modules/managed-mail/plan-change";
import { discoverMailbox } from "./discovery";
import { connectHostedSending } from "@repo/platform/engine/modules/managed-mail/hosted-sending";
import { Hono, type Context } from "hono";
import {
  MailChangePreviewInput,
  MailChangeConfirmInput,
  MailChangeCancelInput,
  MailCheckoutInput,
  MailPlacementInput,
  SendingDomainInput,
  ManagedTestEmailInput,
  MailSendInput,
  MailRelayKeyInput,
  sendingCapInput,
} from "@repo/contracts";
import type { Static } from "@sinclair/typebox";
import { AppError } from "@repo/core";
import { repos } from "@repo/db";
import { env } from "@repo/platform/engine/config/env";
import { getOblienClient } from "@repo/platform/engine/lib/oblien-client";
import {
  cancelEmailCheckout,
  emailCheckout,
  emailPortal,
  sendingNamespace,
} from "@repo/platform/engine/modules/managed-mail/billing";
import {
  activateMailService,
  mailServiceSummary,
} from "@repo/platform/engine/modules/managed-mail/service";
import {
  listMailApiKeys,
  revokeMailApiKey,
  releaseSendingDomain,
  submitMail,
  listSendingDomains,
  prepareSendingDomain,
  verifiedSendingKey,
  linkedSmtpKey,
  sendManagedTestEmail,
  sendingReceipt,
  identitySendingUsage,
  updateSendingCap,
} from "@repo/platform/engine/modules/managed-mail/sending";
import { operationContext, operationData } from "../../lib/operation-context";
import { getRequestContext } from "../../lib/request-context";
import {
  dedicatedCheckout,
  manageDedicatedOrder,
} from "@repo/platform/engine/modules/managed-mail/dedicated";
import { checkPermissionOnResource, permission } from "../../lib/permission";
import type { PermissionSpec } from "../../lib/route-permission";
import { secureRouter } from "../../lib/secure-router";
import { linkedMailRequest, resolveMailAccountTarget } from "../mail/account-target";
import { mailRoutePath } from "../mail/account-path";

const r = secureRouter(new Hono(), {
  module: "mail",
  basePath: "/api/mail",
  mcpExcluded: "Manage hosted mail and its credentials in the Emails dashboard.",
});

r.public("get", "/discovery", { reason: "Find a hosted mailbox login before signing in." }, async (c) => {
  c.header("Cache-Control", "no-store");
  const webmailUrl = env.CLOUD_MODE && await discoverMailbox(c.req.query("domain"));
  return webmailUrl ? c.json({ webmailUrl }) : c.json({ error: "Hosted mailbox server not found." }, 404);
});

/** Cloud owns these operations. On a linked instance, forward only the
 * declared path and its validated body under the organization's connection. */
function cloudRoute(
  method: "get" | "post" | "put" | "delete",
  path: string,
  spec: PermissionSpec,
  handle: (org: string, c: Context) => Promise<object>,
) {
  r[method](path, spec, async (c) => {
    const ctx = getRequestContext(c);
    c.header("Cache-Control", "no-store");
    if (env.CLOUD_MODE) return c.json(await handle(ctx.organizationId, c));
    const request = await linkedMailRequest(ctx);
    if (c.req.param("id") !== undefined) providerId(c);
    const result = await request(mailRoutePath(path, c.req.param()), {
      method: c.req.method,
      ...(spec.body && {
        headers: { "content-type": "application/json" },
        body: await c.req.text(),
      }),
    });
    return c.json(result);
  });
}

async function serviceSummary(org: string, c: Context) {
  const ctx = getRequestContext(c);
  return mailServiceSummary(org, c.req.param("serverId"), (id) =>
    checkPermissionOnResource(ctx, { resourceType: "mail_server", resourceId: id, action: "read" }),
  );
}
cloudRoute("get", "/managed", { tag: "mail_server:list" }, serviceSummary);
cloudRoute("get", "/managed/services/:serverId", { tag: "mail_server:list" }, serviceSummary);
const changePath = "/managed/plans/:id/change";
cloudRoute("get", changePath, { tag: "billing:read" }, (org, c) =>
  mailChangeStatus(org, providerId(c)),
);
cloudRoute("get", changePath + "/:changeId", { tag: "billing:read" }, (org, c) =>
  mailChangeStatus(org, providerId(c), c.req.param("changeId")),
);
cloudRoute(
  "post",
  changePath + "/preview",
  { tag: "billing:admin", body: MailChangePreviewInput, rateLimit: "billing-portal" },
  async (org, c) =>
    previewMailChange(
      org,
      providerId(c),
      await c.req.json<Static<typeof MailChangePreviewInput>>(),
    ),
);
cloudRoute(
  "post",
  changePath,
  { tag: "billing:admin", body: MailChangeConfirmInput, rateLimit: "billing-portal" },
  async (org, c) =>
    confirmMailChange(
      org,
      providerId(c),
      (await c.req.json<Static<typeof MailChangeConfirmInput>>()).quoteId,
    ),
);
cloudRoute(
  "post",
  changePath + "/cancel",
  { tag: "billing:admin", body: MailChangeCancelInput, rateLimit: "billing-portal" },
  async (org, c) =>
    cancelMailChange(
      org,
      providerId(c),
      (await c.req.json<Static<typeof MailChangeCancelInput>>()).changeId,
    ),
);
for (const action of ["resume", "cancel", "portal"] as const) {
  cloudRoute(
    "post",
    "/managed/services/:serverId/" + action,
    { tag: "billing:admin", rateLimit: "billing-portal" },
    (org, c) => manageDedicatedOrder(org, c.req.param("serverId")!, action),
  );
}
cloudRoute(
  "post",
  "/managed/checkout",
  { tag: "billing:admin", rateLimit: "billing-portal", body: MailCheckoutInput },
  async (org, c) => {
    const { plan, product, storageGB, purchaseId, expectedMonthlyCents } =
      await c.req.json<Static<typeof MailCheckoutInput>>();
    if (product === "dedicated") {
      if (!storageGB || !purchaseId || !expectedMonthlyCents)
        throw new AppError("Review the dedicated server and storage before checkout.", 400);
      return dedicatedCheckout(org, plan, storageGB, purchaseId, expectedMonthlyCents);
    }
    if (storageGB !== undefined || purchaseId !== undefined || expectedMonthlyCents !== undefined)
      throw new AppError("VM options require a dedicated mail plan.", 400);
    return emailCheckout(org, plan, product);
  },
);
cloudRoute(
  "post",
  "/managed/checkout/cancel",
  { tag: "billing:admin", rateLimit: "billing-portal" },
  cancelEmailCheckout,
);
cloudRoute(
  "post",
  "/managed/portal",
  { tag: "billing:admin", rateLimit: "billing-portal" },
  emailPortal,
);
cloudRoute(
  "post",
  "/managed",
  { tag: "billing:admin", body: MailPlacementInput },
  async (org, c) => {
    const { placement, cloudServerId } = await c.req.json<Static<typeof MailPlacementInput>>();
    if (cloudServerId) {
      await permission.assert(getRequestContext(c), {
        resourceType: "server",
        resourceId: cloudServerId,
        action: "admin",
      });
    }
    return activateMailService(org, placement, cloudServerId);
  },
);
cloudRoute("delete", "/managed/:serverId/reservation", { tag: "billing:admin" }, async (org, c) => {
  const id = c.req.param("serverId")!;
  const request = await repos.managedMail.forOrganization(org);
  if (!request?.cloudServerId || request.id !== id)
    throw new AppError("Mail reservation not found.", 404);
  await permission.assert(getRequestContext(c), {
    resourceType: "server",
    resourceId: request.cloudServerId,
    action: "admin",
  });
  if (!(await repos.managedMail.cancelVmRequest(org, id)))
    throw new AppError("This request has already changed. Refresh the mail service.", 409);
  return { canceled: true };
});

function providerId(c: Context) {
  const id = c.req.param("id");
  if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id))
    throw new AppError("Invalid mail resource ID.", 400);
  return id;
}

cloudRoute("get", "/sending/domains", { tag: "billing:admin" }, (org) =>
  listSendingDomains(sendingNamespace(org)),
);
cloudRoute("delete", "/sending/domains/:id", { tag: "billing:admin" }, (org, c) =>
  releaseSendingDomain(org, providerId(c)),
);
cloudRoute(
  "post",
  "/sending/domains",
  { tag: "billing:admin", body: SendingDomainInput },
  async (org, c) => {
    const { domain } = await c.req.json<Static<typeof SendingDomainInput>>();
    return prepareSendingDomain(org, domain.trim().toLowerCase());
  },
);
cloudRoute("get", "/sending/domains/:id", { tag: "billing:admin" }, (org, c) =>
  getOblienClient().mail.domains.get(sendingNamespace(org), providerId(c)),
);
cloudRoute("post", "/sending/domains/:id/verify", { tag: "billing:admin" }, (org, c) =>
  getOblienClient().mail.domains.verify(sendingNamespace(org), providerId(c)),
);
cloudRoute("post", "/sending/domains/:id/test-email", {
  tag: "billing:admin", body: ManagedTestEmailInput, rateLimit: "mail-test-send",
}, async (org, c) => sendManagedTestEmail(org, providerId(c), await c.req.json<Static<typeof ManagedTestEmailInput>>()));
cloudRoute("get", "/sending/messages/:id", { tag: "billing:admin" }, (org, c) =>
  sendingReceipt(org, providerId(c)),
);
cloudRoute(
  "post",
  "/sending/domains/:id/key",
  { tag: "billing:admin", rateLimit: "billing-portal" },
  (_org, c) => verifiedSendingKey(getRequestContext(c), providerId(c)),
);
cloudRoute("get", "/sending/keys", { tag: "billing:admin" }, listMailApiKeys);
// Consumed by the local control plane when an administrator opts a domain into SMTP routing.
r.post("/sending/domains/:id/smtp-key", { tag: "billing:admin", body: MailRelayKeyInput, rateLimit: "billing-portal" }, async (c) => {
  if (!env.CLOUD_MODE) throw new AppError("Configure the relay from this server’s Sending settings.", 404);
  const ctx = getRequestContext(c);
  if (ctx.sessionKind !== "bearer" || ctx.principalKind || c.req.header("cookie"))
    throw new AppError("Use the linked Cloud account to configure SMTP.", 403);
  c.header("Cache-Control", "no-store");
  const input = await c.req.json<Static<typeof MailRelayKeyInput>>();
  return c.json(await linkedSmtpKey(ctx.organizationId, providerId(c), input.installation, input.installedId));
});
cloudRoute("delete", "/sending/keys/:id", { tag: "billing:admin" }, (org, c) =>
  revokeMailApiKey(org, providerId(c)),
);
r.post("/send", { tag: "mail_sender:write", body: MailSendInput, authorizationHandledByOperation: true }, async (c) => {
  const input = await c.req.json<Static<typeof MailSendInput>>();
  return c.json(await operationData(c, submitMail(operationContext(c), input)), 202);
});
cloudRoute("get", "/sending/usage", { tag: "billing:read" }, (org) =>
  getOblienClient().mail.usage.get(sendingNamespace(org)),
);
for (const kind of ["senders", "domains"] as const) {
  cloudRoute("get", "/sending/usage/" + kind, { tag: "billing:read" }, async (org, c) => ({
    usage: await identitySendingUsage(org, kind),
    canEdit: await checkPermissionOnResource(getRequestContext(c), {
      resourceType: "billing",
      resourceId: "*",
      action: "admin",
    }),
  }));
  const body = sendingCapInput(kind);
  cloudRoute("put", "/sending/caps/" + kind, { tag: "billing:admin", body }, async (org, c) => {
    const { identity, monthlyCap } = await c.req.json<Static<typeof body>>();
    return updateSendingCap(org, kind, identity, monthlyCap);
  });
}

// Installing the key follows the mailbox target, including a self-hosted installation.
const connectPath = "/managed/:serverId/sending/:id";
for (const method of ["get", "post", "delete"] as const) {
  r[method](connectPath + "/api-relay", { tag: "billing:admin", mcpExcluded: "Manages the private mail-server API relay." }, async c => {
    const org = getRequestContext(c).organizationId;
    const target = await resolveMailAccountTarget(c, "admin");
    if (getRequestContext(c).organizationId !== org || target.kind !== "instance") throw new AppError("Mail server not found.", 404);
    const serverId = c.req.param("serverId")!;
    const id = providerId(c);
    const { connectLinkedSending, linkedApiRelayState } = await import("./connect-sending");
    return c.json(method === "post" ? await connectLinkedSending(c, serverId, id, "api-relay")
      : await linkedApiRelayState(c, serverId, id, method === "delete"));
  });
}
r.post(connectPath + "/smtp", { tag: "billing:admin" }, async (c) => {
  const org = getRequestContext(c).organizationId;
  const target = await resolveMailAccountTarget(c, "admin");
  if (getRequestContext(c).organizationId !== org) throw new AppError("Mail service not found.", 404);
  if (target.kind !== "instance") throw new AppError("Hosted SMTP routing is managed by OpenShip.", 409);
  const { connectLinkedSending } = await import("./connect-sending");
  return c.json(await connectLinkedSending(c, c.req.param("serverId")!, providerId(c), "smtp"));
});
for (const method of ["get", "post"] as const) {
  r[method](connectPath, { tag: "billing:admin" }, async (c) => {
    const serviceId = c.req.param("serverId")!;
    const id = providerId(c);
    const ctx = getRequestContext(c);
    const target = await resolveMailAccountTarget(c, "admin");
    if (getRequestContext(c).organizationId !== ctx.organizationId)
      throw new AppError("Mail service not found.", 404);
    if (target.kind === "linked")
      return c.json(
        await target.request(mailRoutePath(connectPath, c.req.param()), { method: method.toUpperCase() }),
      );
    if (target.kind === "instance") {
      if (method === "get") throw new AppError("Use the linked server’s sending settings.", 404);
      const { connectLinkedSending } = await import("./connect-sending");
      return c.json(await connectLinkedSending(c, serviceId, id));
    }
    return c.json(await connectHostedSending(ctx, serviceId, id, target.engine, method === "post" ? "connect" : "status"));
  });
}
export const managedMailRoutes = r.hono;
