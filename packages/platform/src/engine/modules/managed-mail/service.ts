import { createHash, randomUUID } from "node:crypto";
import { bindReadyMailEngine, engineResponse, sharedMailTarget } from "./engine-client";
import { pooledSendingAllowance } from "./sending";
import { enrolledMailEngine } from "./dedicated-fleet";
import { dedicatedCoverage } from "./dedicated";
import { z } from "zod";
import { MAIL_PLACEMENTS } from "@repo/core/managed-mail";
import { AppError, PRICING } from "@repo/core";
import { repos } from "@repo/db";
import {
  managedMailboxCapacity,
  type ManagedMailSummary,
  type MailPlacement,
} from "@repo/contracts";
import { env } from "../../config/env";
import { createProvisionLock, tryWithProvisionLock } from "../../lib/provision-lock";
import { workspaceForServer } from "../../lib/cloud-workspace-scope";
import {
  assertHostedMailEnrollment,
  paidEmailPlan,
  mailCheckoutSummary,
  mailEntitlements,
  mailEntitlement,
  sendingNamespace,
} from "./billing";

const hostname = z.hostname();
const engineSchema = z
  .object({
    origin: z.url(),
    serverId: z.string().regex(/^[a-zA-Z0-9_-]+$/),
    token: z.string().min(1),
    hostname: hostname.toLowerCase().regex(/^mail\./),
    webmailUrl: z.url(),
    shared: z.boolean().optional(),
    cloudServerId: z.string().min(1).optional(),
    providerVmId: z.string().min(1).optional(),
    prepare: z.boolean().default(false),
    placement: z.enum(MAIL_PLACEMENTS),
    // Usable mailbox space on this VM, after reserving space for the OS and logs.
    mailboxStorageMB: z.number().int().positive().optional(),
  })
  .strict();
export type MailEngine = z.infer<typeof engineSchema>;
function configError() {
  return new AppError(
    "Managed mail capacity is misconfigured. Contact the operator.",
    503,
    "MAIL_CAPACITY_CONFIG",
  );
}
function secureOrigin(value: string) {
  const url = new URL(value);
  return (
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    url.pathname === "/" &&
    (url.protocol === "https:" ||
      (env.NODE_ENV !== "production" &&
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  );
}
// The engine identity is stable across process restarts and display-name changes.
export function engineIdentity(engine: MailEngine) {
  return createHash("sha256")
    .update(new URL(engine.origin).origin + "/" + engine.serverId)
    .digest("hex");
}
export function mailEngines() {
  let rows: MailEngine[];
  try {
    rows = z.array(engineSchema).parse(JSON.parse(env.OPENSHIP_MAIL_ENGINES ?? "[]"));
  } catch {
    throw configError();
  }
  const vmIds = rows.flatMap((row) => [row.cloudServerId, row.providerVmId].filter(Boolean));
  if (
    rows.some(
      (row) =>
        (row.shared && row.placement !== "standard") ||
        ((row.cloudServerId || row.providerVmId) && row.placement !== "dedicated") ||
        (row.providerVmId && row.cloudServerId) ||
        !secureOrigin(row.origin) ||
        !secureOrigin(row.webmailUrl),
    ) ||
    new Set(rows.map(engineIdentity)).size !== rows.length ||
    new Set(vmIds).size !== vmIds.length ||
    new Set(rows.map((row) => new URL(row.webmailUrl).origin)).size !== rows.length ||
    new Set(rows.map((row) => row.hostname.toLowerCase())).size !== rows.length
  )
    throw configError();
  return rows;
}

export async function requireMailEntitlement(org: string, serviceId?: string) {
  const row = serviceId ? await repos.managedMail.service(org, serviceId) : null;
  if (serviceId && !row) throw new AppError("Mail service not found.", 404);
  const entitlement = row?.order
    ? await dedicatedCoverage(row)
    : await mailEntitlement(org, "mailboxes");
  if (!entitlement)
    throw new AppError(
      "A hosted mailbox plan or paid compute plan is required.",
      402,
      "MAIL_PLAN_REQUIRED",
    );
  return entitlement;
}

type Binding = NonNullable<Awaited<ReturnType<typeof repos.managedMail.forOrganization>>>;
async function boundEngine(org: string, row: Binding) {
  if (row.cloudServerId && !row.order) await requireMailVm(org, row.cloudServerId);
  const enrolled = row.order?.worker ? enrolledMailEngine(row) : undefined;
  const target = (enrolled ? [enrolled] : mailEngines()).find(
    (engine) =>
      engineIdentity(engine) === row.engine &&
      engine.hostname === row.hostname &&
      ((row.order ? engine.providerVmId : engine.cloudServerId) ?? null) === row.cloudServerId &&
      (!engine.providerVmId || !!row.order) &&
      engine.placement === row.placement &&
      !!engine.shared === row.shared,
  );
  if (!target)
    throw new AppError(
      "Your mail engine is temporarily unavailable.",
      503,
      "MAIL_ENGINE_UNAVAILABLE",
    );
  return row.order
    ? {
        ...target,
        mailboxStorageMB: Math.min(row.order.storageGB * 1024, target.mailboxStorageMB ?? Infinity),
      }
    : target;
}
/** DNS selects a possible assignment. Only the assigned worker can confirm hosting. */
export async function hostedMailboxOrigin(selector: { id: string } | { hostname: string }, domain: string) {
  const row = await repos.managedMail.discoverMailboxService(selector);
  if (!row?.organizationId) return null;
  const engine = await boundEngine(row.organizationId, row);
  const path = "/admin/" + encodeURIComponent(engine.serverId) + "/domains/" + encodeURIComponent(domain);
  try {
    const response = await engineResponse(engine, path, "GET", undefined, 6_000);
    const result = z.object({ domain: z.object({ domain: z.string(), active: z.boolean() }) }).safeParse(await response.json());
    if (!result.success) throw new AppError("The mail worker returned an invalid domain.", 502);
    if (result.data.domain.domain === domain && result.data.domain.active)
      return new URL(engine.webmailUrl).origin;
    return null;
  } catch (error) {
    if (error instanceof AppError && error.statusCode === 404) return null;
    throw error;
  }
}
async function summary(
  org: string,
  row: Binding,
): Promise<NonNullable<ManagedMailSummary["service"]>> {
  if (row.provisioning) {
    return {
      id: row.id,
      placement: row.placement,
      ...(row.cloudServerId ? { cloudServerId: row.cloudServerId } : {}),
      provisioning:
        row.orderState === "checkout"
          ? "payment"
          : !row.cloudServerId
            ? "vm"
            : row.engine
              ? "install"
              : "network",
    };
  }
  const target = await boundEngine(org, row);
  return {
    id: row.id,
    placement: row.placement,
    ...(row.cloudServerId ? { cloudServerId: row.cloudServerId } : {}),
    ...(row.placement === "dedicated" && target.mailboxStorageMB !== undefined
      ? { mailboxStorageMB: target.mailboxStorageMB }
      : {}),
    hostname: target.hostname,
    webmailUrl: target.webmailUrl,
  };
}

export async function mailServiceSummary(
  org: string,
  serviceId?: string,
  canRead?: (id: string) => Promise<boolean>,
): Promise<ManagedMailSummary> {
  const [primary, orders] = await Promise.all([
    repos.managedMail.forOrganization(org),
    repos.managedMail.orders(org),
  ]);
  const all = [...(primary ? [primary] : []), ...orders];
  const readable = canRead ? await Promise.all(all.map((item) => canRead(item.id))) : undefined;
  const bindings = all.filter((_, index) => !readable || readable[index]);
  const row = bindings.find((item) => (serviceId ? item.id === serviceId : !item.order));
  if (serviceId && !row) throw new AppError("Mail service not found.", 404);
  const services = bindings.map((item) => ({
    id: item.id,
    placement: item.placement,
    hostname: item.hostname ?? undefined,
    plan: item.order?.plan,
    storageGB: item.order?.storageGB,
    pendingCheckout: item.orderState === "checkout",
  }));
  const service = row ? await summary(org, row) : null;
  const account = await repos.managedMail.account(org);
  let paid: ReturnType<typeof paidEmailPlan> | undefined;
  const readSubscription = () => (paid ??= paidEmailPlan(org));
  let billed: Awaited<ReturnType<typeof paidEmailPlan>> = null;
  let grant, mailboxGrant;
  let recipients = 0;
  let defaultProduct: ManagedMailSummary["defaultProduct"];
  try {
    const entitlement = mailEntitlements(org, readSubscription);
    grant = await entitlement("sending");
    defaultProduct = grant ? (grant.sendingOnly ? "sending" : "mailboxes") : undefined;
    mailboxGrant = grant?.sendingOnly ? await entitlement("mailboxes") : grant;
    if (!row?.order && (paid || account?.checkout?.id)) billed = await readSubscription();
    const allowance = await pooledSendingAllowance(org, grant, orders);
    recipients = allowance?.recipients ?? 0;
    if (row?.order) grant = mailboxGrant = allowance?.orders.get(row.id) ?? null;
  } catch (error) {
    if (!service && services.length === 0) throw error;
    return {
      service,
      services,
      plan: null,
      product: row?.order ? "dedicated" : undefined,
      billingUnavailable: true,
      hostedEnrollmentEnabled: env.OPENSHIP_MAIL_HOSTED_ENROLLMENT_ENABLED,
    };
  }
  const inventory = service || !env.OPENSHIP_MAIL_HOSTED_ENROLLMENT_ENABLED ? [] : mailEngines();
  const slots = inventory.filter(
    (engine) =>
      !engine.cloudServerId &&
      !engine.providerVmId &&
      (engine.placement === "standard" || mailboxGrant?.dedicated),
  );
  const occupancy = await Promise.all(
    slots.map((engine) =>
      repos.managedMail.occupied(engineIdentity(engine), engine.hostname, engine.shared),
    ),
  );
  const checkout = row?.order
    ? {}
    : await mailCheckoutSummary(account, !!billed);
  const plan = grant && PRICING.mail.plans[grant.plan];
  const mailboxPlan = mailboxGrant && PRICING.mail.plans[mailboxGrant.plan];
  return {
    service,
    services,
    plan: grant?.plan ?? null,
    subscriptionTarget: row?.order
      ? row.orderState === "funded"
        ? row.id
        : undefined
      : billed
        ? "account"
        : undefined,
    subscriptionPlan: billed
      ? { plan: billed.plan, product: billed.sendingOnly ? "sending" : "mailboxes" }
      : undefined,
    defaultProduct,
    mailboxPlan: mailboxGrant?.plan ?? null,
    limits: plan
      ? {
          domains: mailboxGrant?.allowance?.domains ?? mailboxPlan?.domains ?? plan.domains,
          recipients,
          ...(mailboxPlan
            ? managedMailboxCapacity(mailboxPlan, mailboxGrant?.dedicated, service)
            : { storageMB: 0, mailboxes: 0 }),
        }
      : undefined,
    ...checkout,
    product: row?.order
      ? "dedicated"
      : grant
        ? "sendingOnly" in grant && grant.sendingOnly
          ? "sending"
          : "mailboxes"
        : undefined,
    checkoutEnabled: env.BILLING_ENABLED,
    hostedEnrollmentEnabled: env.OPENSHIP_MAIL_HOSTED_ENROLLMENT_ENABLED,
    sendingConfigured: !!account?.sendingEnabled,
    sendingAllowance: recipients,
    dedicated: !!mailboxGrant?.dedicated,
    hostingAvailable:
      !!service ||
      slots.some((engine, index) => engine.placement === "standard" && !occupancy[index]),
    reservedHostingAvailable: slots.some(
      (engine, index) =>
        engine.placement === "dedicated" && !engine.cloudServerId && !occupancy[index],
    ),
  };
}
export async function requireMailVm(org: string, serverId: string) {
  const { workspace } = await workspaceForServer(org, serverId);
  if (!workspace || workspace.remote || workspace.deletionInProgress)
    throw new AppError("Select an active Cloud VM in this organization.", 409);
}

export async function activateMailService(
  org: string,
  placement: MailPlacement,
  cloudServerId?: string,
) {
  return createProvisionLock(`managed-mail:activate:${org}`).run(async () => {
    const existing = await repos.managedMail.forOrganization(org);
    if (cloudServerId && placement !== "dedicated")
      throw new AppError("A VM is only used for dedicated mail.", 400);
    if (existing) {
      if (existing.placement !== placement || existing.cloudServerId !== (cloudServerId ?? null))
        throw new AppError(
          "Mail is already active on another target. Moving existing inboxes requires a migration.",
          409,
        );
      return summary(org, existing);
    }
    assertHostedMailEnrollment();
    const grant = await requireMailEntitlement(org);
    if (cloudServerId)
      throw new AppError("Choose a new dedicated mail server in Email plans.", 409);
    if (placement === "dedicated" && !grant.dedicated)
      throw new AppError(
        "Dedicated mail requires a reserved VM entitlement.",
        402,
        "MAIL_DEDICATED_REQUIRED",
      );
    for (const engine of mailEngines().filter(
      (item) => item.placement === placement && !item.cloudServerId && !item.providerVmId,
    )) {
      const slot = engineIdentity(engine);
      const lock = "managed-mail:slot:" + slot;
      const reserve = async () => {
        if (await repos.managedMail.occupied(slot, engine.hostname, engine.shared)) return null;
        if (!(await bindReadyMailEngine(engine, sendingNamespace(org)))) return null;
        return repos.managedMail.claim({
          organizationId: org,
          id: "managed-mail-" + randomUUID(),
          placement,
          shared: !!engine.shared,
          engine: slot,
          hostname: engine.hostname,
        });
      };
      const row = engine.shared
        ? await createProvisionLock(lock).run(reserve)
        : await tryWithProvisionLock(lock, reserve);
      if (row) return summary(org, row);
    }
    throw new AppError(
      "No mail engine is available for this placement yet.",
      503,
      "MAIL_CAPACITY_FULL",
    );
  });
}
export async function customerEngine(org: string, serviceId: string) {
  const row = await repos.managedMail.service(org, serviceId);
  if (!row || row.orderState === "closed")
    throw new AppError("Mail service not found", 404, "MAIL_NOT_FOUND");
  if (row.provisioning)
    throw new AppError("Your mail VM is being prepared.", 409, "MAIL_PROVISIONING");
  const engine = await boundEngine(org, row);
  return row.shared ? sharedMailTarget(engine, sendingNamespace(org), row.id) : { ...engine, tenant: undefined };
}
