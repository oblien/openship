import { createHash } from "node:crypto";
import type { ExecutionContext } from "../../../context";
import { checkPermission } from "../../lib/authorization";
import { createMailSendToken } from "../tokens/token.service";
import { dedicatedCoverage } from "./dedicated";
import { repos } from "@repo/db";
import { ensureMailAccount, mailEntitlement, sendingNamespace } from "./billing";
import { AppError, PRICING } from "@repo/core";
import { OblienError } from "@repo/adapters";
import { getOblienClient } from "../../lib/oblien-client";
import { createProvisionLock } from "../../lib/provision-lock";
import type { MailSendRequest, ManagedTestEmailRequest, ManagedMailReceipt, SendingIdentityKind } from "@repo/contracts/managed-mail";

export async function pooledSendingAllowance(
  org: string,
  base: Awaited<ReturnType<typeof mailEntitlement>>,
  rows: Awaited<ReturnType<typeof repos.managedMail.orders>>,
) {
  const orders = new Map<string, NonNullable<Awaited<ReturnType<typeof dedicatedCoverage>>>>();
  for (const row of rows) {
    if (row.organizationId !== org || row.orderState !== "funded") continue;
    const grant = await dedicatedCoverage(row);
    if (grant) orders.set(row.id, grant);
  }
  const grants = [...(base ? [base] : []), ...orders.values()];
  if (!grants.length) return null;
  const allowance = {
    recipients: 0,
    dailyRecipients: 0,
    domains: 0,
    until: grants[0]!.until,
    orders,
  };
  for (const grant of grants) {
    const plan = grant.allowance ?? PRICING.mail.plans[grant.plan];
    allowance.recipients += plan.recipients;
    allowance.dailyRecipients += plan.dailyRecipients;
    allowance.domains += plan.domains;
    if (grant.until < allowance.until) allowance.until = grant.until;
  }
  return allowance;
}

export async function reconcileSending(org: string) {
  return createProvisionLock(`managed-mail:sending:${org}`).run(async () => {
    const grant = await pooledSendingAllowance(
      org,
      await mailEntitlement(org),
      await repos.managedMail.orders(org),
    );
    if (!grant) {
      const account = await repos.managedMail.account(org);
      if (account?.sendingEnabled) {
        const tenants = getOblienClient().mail.tenants;
        const tenant = await tenants.get(account.namespace);
        if (!tenant.holds.includes("billing"))
          await tenants.pause(account.namespace, {
            hold: "billing",
            reason: "Openship Mail subscription expired",
          });
      }
      return null;
    }
    const namespace = sendingNamespace(org);
    await ensureMailAccount(org);
    const client = getOblienClient();
    const mail = client.mail;
    const tenant = await mail.tenants.ensure(namespace);
    if (tenant.namespace !== namespace) {
      // The Mail API accepts a slug and can return the namespace's canonical ID.
      const { data } = await client.namespaces.get(namespace);
      if (data.slug !== namespace || !data.id || data.id !== tenant.namespace)
        throw new AppError("Unexpected mail namespace.", 502);
    }
    const current = await mail.tenants.getPolicy(namespace);
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const periodEnd = new Date(Math.min(next.getTime(), grant.until.getTime()));
    const policy = {
      period: grant.recipients,
      daily: grant.dailyRecipients,
      burst: 10,
      domains: grant.domains,
      keys: grant.domains * 3,
      periodStart: start.toISOString(),
      periodEnd: periodEnd.toISOString(),
    };
    if (
      current.period !== policy.period ||
      current.daily !== policy.daily ||
      current.burst !== policy.burst ||
      current.domains !== policy.domains ||
      current.keys !== policy.keys ||
      Date.parse(current.periodStart ?? "") !== start.getTime() ||
      Date.parse(current.periodEnd ?? "") !== periodEnd.getTime()
    )
      await mail.tenants.updatePolicy(namespace, { ...policy, revision: current.revision });
    if (tenant.holds.includes("billing") && tenant.reason === "Openship Mail subscription expired")
      await mail.tenants.resume(namespace, {
        hold: "billing",
        reason: "Openship Mail subscription active",
      });
    await repos.managedMail.updateAccount(org, { sendingEnabled: true });
    return namespace;
  });
}
export async function activateSending(org: string) {
  const namespace = await reconcileSending(org);
  if (!namespace)
    throw new AppError(
      "An active email or paid compute plan is required.",
      402,
      "MAIL_PLAN_REQUIRED",
    );
  return namespace;
}

async function allMailPages<
  Page extends { data: unknown[]; nextCursor: string | null; monthStart?: string },
>(read: (cursor?: string) => Promise<Page>) {
  const first = await read();
  const data = [...first.data] as Page["data"];
  const seen = new Set<string>();
  let cursor = first.nextCursor;
  while (cursor) {
    if (seen.has(cursor)) throw new AppError("Unexpected mail pagination cursor.", 502);
    seen.add(cursor);
    const page = await read(cursor);
    if (page.monthStart !== first.monthStart)
      throw new AppError("The reporting month changed. Refresh the usage report.", 503);
    data.push(...page.data);
    cursor = page.nextCursor;
  }
  return { ...first, data, nextCursor: null };
}
export async function identitySendingUsage(org: string, kind: SendingIdentityKind) {
  if (!(await repos.managedMail.account(org))?.sendingEnabled) return null;
  const collection = getOblienClient().mail[kind];
  return allMailPages((cursor) =>
    collection.listUsage(sendingNamespace(org), { limit: 100, cursor }),
  );
}

export async function updateSendingCap(
  org: string,
  kind: SendingIdentityKind,
  identity: string,
  cap: number | null,
) {
  const enabled = (await repos.managedMail.account(org))?.sendingEnabled;
  if (!enabled && cap === null) return { success: true };
  const namespace = enabled ? sendingNamespace(org) : await activateSending(org);
  const collection = getOblienClient().mail[kind];
  const key = identity.toLowerCase();
  try {
    return cap === null
      ? await collection.clearCap(namespace, key)
      : await collection.setCap(namespace, key, cap);
  } catch (error) {
    if (error instanceof OblienError && error.status === 404 && error.code === "mail_not_found")
      throw new AppError("Connect and verify the domain in Sending before changing its limits.", 409, "MAIL_SENDING_IDENTITY_MISSING");
    throw error;
  }
}
export function listSendingDomains(namespace: string) {
  return allMailPages((cursor) =>
    getOblienClient().mail.domains.list(namespace, { limit: 100, cursor }),
  );
}
export function listSendingKeys(namespace: string) {
  return allMailPages((cursor) =>
    getOblienClient().mail.keys.list(namespace, { limit: 100, cursor }),
  );
}

export async function prepareSendingDomain(org: string, domain: string) {
  const namespace = await activateSending(org);
  const mail = getOblienClient().mail;
  const existing = (await listSendingDomains(namespace)).data.find(
    (item) => item.domain === domain && !item.disabled,
  );
  return existing
    ? mail.domains.get(namespace, existing.id)
    : mail.domains.add(namespace, { domain });
}
async function readyDomain(namespace: string, id: string) {
  const mail = getOblienClient().mail;
  const domain = await mail.domains.get(namespace, id);
  if (domain.state !== "ready")
    throw new AppError("Verify this sending domain first.", 409, "MAIL_DOMAIN_PENDING");
  if (domain.id !== id) throw new AppError("Unexpected sending domain.", 502);
  return { namespace, mail, domain };
}

export async function verifiedSendingKey(ctx: ExecutionContext, id: string) {
  const { domain } = await readyDomain(await activateSending(ctx.organizationId), id);
  const key = await createMailSendToken(ctx, domain.id, domain.domain);
  return { id: key.id, key: key.token };
}

/** Postfix needs an SMTP credential. Its single SASL map serves the selected
 * domains of this installation. The tenant enforces verified From and quota. */
export async function linkedSmtpKey(org: string, domainId: string, installation: string, installedId?: string) {
  const { namespace, mail } = await readyDomain(await activateSending(org), domainId);
  const name = "OpenShip SMTP · " + installation;
  return createProvisionLock("managed-mail:smtp-key:" + namespace + ":" + installation).run(async () => {
    const keys = (await listSendingKeys(namespace)).data.filter(key => key.name === name && key.domainId === null);
    // The worker supplies only the ID whose password it still has. This also
    // recovers credentials left behind by an interrupted installation.
    for (const key of keys) {
      if (key.id !== installedId) await mail.keys.revoke(namespace, key.id);
    }
    if (installedId && keys.some(key => key.id === installedId)) return { namespace, id: installedId };
    const key = await mail.keys.create(namespace, { name });
    return { namespace, id: key.id, secret: key.secret };
  });
}

// Older dashboard versions issued provider keys with this name. The same
// namespace also contains relay credentials reserved for the mail workers.
async function customerProviderKeys(org: string) {
  const { data } = await listSendingKeys(sendingNamespace(org));
  return data.filter(key => (key.domainId && key.name.startsWith("Openship Mail · ")) ||
    (key.domainId === null && /^OpenShip SMTP · [a-f0-9]{64}$/.test(key.name)));
}

export async function listMailApiKeys(org: string) {
  const [keys, legacy] = await Promise.all([
    repos.personalAccessToken.listMailSendKeys(org),
    customerProviderKeys(org),
  ]);
  return { data: [...keys, ...legacy.map(({ id, domainId, name, prefix, createdAt, lastUsedAt }) => ({
    id, domainId, name, prefix, createdAt, lastUsedAt, ...(domainId ? { legacy: true } : { smtp: true }),
  }))] };
}

export async function revokeMailApiKey(org: string, id: string) {
  if (id.startsWith("pat_")) {
    if (await repos.personalAccessToken.revokeMailSendKeys(org, { id }))
      return { revoked: true };
  } else if ((await customerProviderKeys(org)).some(key => key.id === id)) {
    await getOblienClient().mail.keys.revoke(sendingNamespace(org), id);
    return { revoked: true };
  }
  throw new AppError("Email API key not found.", 404);
}

export async function releaseSendingDomain(org: string, domainId: string) {
  const result = await getOblienClient().mail.domains.remove(sendingNamespace(org), domainId);
  await repos.personalAccessToken.revokeMailSendKeys(org, { domainId });
  return result;
}

export async function submitMail(ctx: ExecutionContext, input: MailSendRequest) {
  if (ctx.principalKind !== "pat" || !ctx.tokenScope || ctx.credential?.organizationId !== ctx.organizationId)
    throw new AppError("An email sending key is required.", 401, "MAIL_KEY_REQUIRED");
  const grants = await repos.patGrant.listByToken(ctx.tokenScope.tokenId);
  const grant = grants[0];
  if (grants.length !== 1 || grant?.resourceType !== "mail_sender" || grant.resourceId === "*" ||
      grant.permissions.length !== 1 || grant.permissions[0] !== "write" || !await checkPermission(ctx.userId, ctx.organizationId, {
        resourceType: "billing", resourceId: "*", action: "admin",
      })) throw new AppError("This email key cannot send.", 403, "MAIL_KEY_SCOPE");

  const { idempotencyKey, ...message } = input;
  if (!message.text && !message.html)
    throw new AppError("Supply a text or HTML body.", 400, "MAIL_BODY_REQUIRED");
  const recipients = message.to.length + (message.cc?.length ?? 0) + (message.bcc?.length ?? 0);
  if (recipients < 1 || recipients > 50)
    throw new AppError("Supply between 1 and 50 recipients.", 400, "MAIL_RECIPIENT_LIMIT");

  // The namespace enforces the same expiring allowance, holds and sender caps
  // as webmail. Provisioning and billing reconciliation stay off the send path.
  try {
    const { namespace, mail, domain } = await readyDomain(sendingNamespace(ctx.organizationId), grant.resourceId);
    if (message.from.split("@")[1]?.toLowerCase() !== domain.domain.toLowerCase())
      throw new AppError("The From address must belong to this key’s domain.", 403, "MAIL_KEY_SCOPE");
    const requestId = createHash("sha256").update(JSON.stringify([domain.id, idempotencyKey])).digest("hex");
    const receipt = await mail.messages.send(namespace, message, { idempotencyKey: "openship-api-" + requestId });
    return { context: ctx, data: publicReceipt(receipt) };
  } catch (error) {
    if (!(error instanceof OblienError)) throw error;
    switch (error.code) {
      case "mail_quota_exhausted":
      case "mail_throttled":
        throw new AppError("The sending limit was reached.", 429, error.code);
      case "mail_idempotency_conflict":
        throw new AppError("This idempotency key was used for a different message.", 409, error.code);
      case "mail_tenant_paused":
      case "mail_domain_unverified":
      case "mail_sender_unauthorized":
      case "mail_not_found":
        throw new AppError("Sending is unavailable for this domain.", 403, error.code);
      default:
        throw new AppError("Email submission is unavailable. Retry with the same idempotency key.", 503, "MAIL_UNAVAILABLE");
    }
  }
}

function publicReceipt({ id, state, reason }: ManagedMailReceipt): ManagedMailReceipt {
  return { id, state, reason };
}

export async function sendManagedTestEmail(org: string, domainId: string, input: ManagedTestEmailRequest) {
  const { namespace, mail, domain } = await readyDomain(await activateSending(org), domainId);
  const from = "openship@" + domain.domain;
  const receipt = await mail.messages.send(namespace, {
    from, to: [input.to], subject: "OpenShip Mail test",
    text: `This test email was sent from ${from} through the OpenShip Mail dashboard.`,
  }, { idempotencyKey: "openship-test-" + input.idempotencyKey });
  return { from, to: input.to, receipt: publicReceipt(receipt) };
}

export async function sendingReceipt(org: string, id: string) {
  return publicReceipt(await getOblienClient().mail.messages.get(sendingNamespace(org), id));
}
