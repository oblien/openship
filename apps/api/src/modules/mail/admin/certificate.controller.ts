import type { Context } from "hono";
import { assertNotCloud, isServerInOrg, param } from "../../../lib/controller-helpers";
import { permission } from "../../../lib/permission";
import { getRequestContext } from "../../../lib/request-context";
import {
  getMailCertificateStatus,
  renewMailCertificate,
  setMailCertificateAutoRenew,
} from "@repo/platform/engine/modules/mail/mail-certificate.service";

async function guard(c: Context, action: "read" | "admin") {
  const unavailable = assertNotCloud(c);
  if (unavailable) return unavailable;
  const serverId = param(c, "serverId");
  const ctx = getRequestContext(c);
  await permission.assert(ctx, { resourceType: "mail_server", resourceId: serverId, action });
  if (!(await isServerInOrg(ctx, serverId))) return c.json({ error: "Server not found" }, 404);
}

export async function getCertificate(c: Context) {
  const rejected = await guard(c, "read");
  if (rejected) return rejected;
  return c.json(await getMailCertificateStatus(param(c, "serverId")));
}

export async function checkCertificate(c: Context) {
  const rejected = await guard(c, "read");
  if (rejected) return rejected;
  return c.json(await getMailCertificateStatus(param(c, "serverId"), true));
}

export async function renewCertificate(c: Context) {
  const rejected = await guard(c, "admin");
  if (rejected) return rejected;
  return c.json(await renewMailCertificate(param(c, "serverId")));
}

export async function updateCertificate(c: Context) {
  const rejected = await guard(c, "admin");
  if (rejected) return rejected;
  const body = await c.req.json();
  if (typeof body.autoRenew !== "boolean")
    return c.json({ error: "autoRenew must be a boolean" }, 400);
  return c.json(await setMailCertificateAutoRenew(param(c, "serverId"), body.autoRenew));
}
