import type { BillingPlanChangeQuote } from "./billing";
import { Type, type Static } from "@sinclair/typebox";

import {
  PAID_MAIL_PLANS,
  MAIL_PLACEMENTS,
  MAIL_PRODUCTS,
  type MailProduct,
  type MailPlacement,
  type PaidMailPlan,
} from "@repo/core/managed-mail";
export type { PaidMailPlan, MailPlacement, MailProduct } from "@repo/core/managed-mail";

const paidPlan = Type.Union(PAID_MAIL_PLANS.map((plan) => Type.Literal(plan)));
export type MailPlan = PaidMailPlan | "included";
const count = Type.Integer({ minimum: 1 });
const cents = Type.Integer({ minimum: 0 });
const productCopy = Type.Object({ name: Type.String(), description: Type.String() });
export const MailPricingSchema = Type.Object({
  features: Type.Object({
    shared: Type.Array(Type.String()),
    dedicated: Type.Array(Type.String()),
    relay: Type.Array(Type.String()),
  }),
  products: Type.Object({ mailboxes: productCopy, dedicated: productCopy, sending: productCopy }),
  dedicatedStorage: Type.Array(Type.Object({ storageGB: count, vmMonthlyCents: cents }), {
    minItems: 1,
  }),
  tiers: Type.Array(
    Type.Object({
      id: paidPlan,
      popular: Type.Boolean(),
      name: Type.String(),
      description: Type.String(),
      checkoutPlan: Type.Union([paidPlan, Type.Null()]),
      monthlyCents: cents,
      sendingMonthlyCents: cents,
      domains: count,
      mailboxes: count,
      storageMB: count,
      recipients: count,
    }),
    { minItems: 1 },
  ),
});
export type MailPricing = Static<typeof MailPricingSchema>;
export const isManagedMailId = (id: string) => id.startsWith("managed-mail-");
export const MAIL_TENANT_TOKEN_PREFIX = "opsh_mail_";
export const MAIL_SERVICE_HEADER = "x-openship-mail-service";
export const managedMailNamespacePattern = /^openship-mail-[a-f0-9]{32}$/;
export function managedMailDomainProof(serviceId: string, domain: string) {
  return {
    name: "_openship-mail." + domain.trim().toLowerCase(),
    value: "openship-mail=" + serviceId,
  };
}
type MailboxHost = { placement: MailPlacement; cloudServerId?: string; mailboxStorageMB?: number };

export function managedMailboxCapacity(
  { storageMB, mailboxes }: { storageMB: number; mailboxes: number },
  dedicated: boolean | undefined,
  host?: MailboxHost | null,
) {
  if (
    host?.placement === "dedicated" &&
    (dedicated || host.cloudServerId) &&
    host.mailboxStorageMB !== undefined
  )
    return { storageMB: host.mailboxStorageMB, mailboxes: null };
  return { storageMB, mailboxes };
}

export interface ManagedMailSummary {
  services?: Array<{
    id: string;
    placement: MailPlacement;
    hostname?: string;
    plan?: PaidMailPlan;
    storageGB?: number;
    pendingCheckout?: boolean;
  }>;
  subscriptionTarget?: string;
  subscriptionPlan?: { plan: PaidMailPlan; product: Exclude<MailProduct, "dedicated"> };
  defaultProduct?: Exclude<MailProduct, "dedicated">;
  mailboxPlan?: MailPlan | null;
  plan: MailPlan | null;
  limits?: { storageMB: number; mailboxes: number | null; domains: number; recipients: number };
  billingUnavailable?: boolean;
  checkoutEnabled?: boolean;
  hostedEnrollmentEnabled?: boolean;
  dedicatedEnrollmentEnabled?: boolean;
  hasBillingAccount?: boolean;
  sendingConfigured?: boolean;
  sendingAllowance?: number;
  pendingPlan?: PaidMailPlan;
  pendingProduct?: MailProduct;
  product?: MailProduct;
  dedicated?: boolean;
  hostingAvailable?: boolean;
  reservedHostingAvailable?: boolean;
  service:
    | (MailboxHost & { id: string } & (
          | { provisioning: "payment" | "vm" | "network" | "install" }
          | { provisioning?: undefined; hostname: string; webmailUrl: string }
        ))
    | null;
}
export const MailCheckoutInput = Type.Object(
  {
    plan: paidPlan,
    product: Type.Optional(Type.Union(MAIL_PRODUCTS.map((product) => Type.Literal(product)))),
    storageGB: Type.Optional(count),
    expectedMonthlyCents: Type.Optional(cents),
    purchaseId: Type.Optional(
      Type.String({
        pattern: "^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$",
      }),
    ),
  },
  { additionalProperties: false },
);
export const MailPlacementInput = Type.Object(
  {
    placement: Type.Union(MAIL_PLACEMENTS.map((placement) => Type.Literal(placement))),
    cloudServerId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  },
  { additionalProperties: false },
);
export const SendingDomainInput = Type.Object(
  {
    domain: Type.String({ minLength: 3, maxLength: 253, pattern: "^[a-zA-Z0-9.-]+$" }),
  },
  { additionalProperties: false },
);
export type SendingDomainRequest = Static<typeof SendingDomainInput>;
export const MailRelayKeyInput = Type.Object({
  installation: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  installedId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
}, { additionalProperties: false });
export const MAIL_SEND_PATH = "/mail/send";
const address = Type.String({ maxLength: 254, pattern: "^[a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$" });
export const MailSendInput = Type.Object({
  from: address,
  to: Type.Array(address, { maxItems: 50 }),
  cc: Type.Optional(Type.Array(address, { maxItems: 50 })),
  bcc: Type.Optional(Type.Array(address, { maxItems: 50 })),
  replyTo: Type.Optional(Type.Array(address, { maxItems: 50 })),
  subject: Type.String({ minLength: 1, maxLength: 998, pattern: "^[^\\x00-\\x1f\\x7f]+$" }),
  text: Type.Optional(Type.String({ minLength: 1, maxLength: 250000 })),
  html: Type.Optional(Type.String({ minLength: 1, maxLength: 250000 })),
  idempotencyKey: Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$" }),
}, { additionalProperties: false });
export type MailSendRequest = Static<typeof MailSendInput>;
export const ManagedTestEmailInput = Type.Object({
  to: address,
  idempotencyKey: Type.String({ minLength: 16, maxLength: 64, pattern: "^[a-zA-Z0-9_-]+$" }),
}, { additionalProperties: false });
export type ManagedTestEmailRequest = Static<typeof ManagedTestEmailInput>;
export interface ManagedMailReceipt {
  id: string;
  state: "queued" | "dispatching" | "unknown" | "accepted" | "delivered" | "delayed" | "bounced" | "complained" | "suppressed" | "failed";
  reason: string | null;
}
export type SendingIdentityKind = "senders" | "domains";
export function sendingCapInput(kind: SendingIdentityKind) {
  return Type.Object(
    {
      identity:
        kind === "domains"
          ? SendingDomainInput.properties.domain
          : Type.String({
              maxLength: 254,
              pattern: "^[^@\\s\\x00-\\x1f\\x7f]+@[a-zA-Z0-9.-]+$",
            }),
      monthlyCap: Type.Union([
        Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
        Type.Null(),
      ]),
    },
    { additionalProperties: false },
  );
}
export interface SendingIdentityUsage {
  accepted: number;
  pending: number;
  monthlyCap: number | null;
}
export interface SendingUsageSnapshot {
  canEdit: boolean;
  usage: {
    data: Array<SendingIdentityUsage & { identity: string }>;
    monthStart: string;
    resetAt: string;
    unattributed: { accepted: number; pending: number };
  } | null;
}
export interface SendingDomainStatus {
  id: string;
  domain: string;
  state: "pending_dns" | "verifying" | "ready" | "verification_failed" | "disabled";
  checkedAt: string;
  reason: string | null;
  records: Array<{ type: string; name: string; value: string; status: "pending" | "verified" | "lookup_error" }>;
}

export const MailChangePreviewInput = Type.Object(
  {
    plan: paidPlan,
    product: Type.Optional(Type.Literal("mailboxes")),
    storageGB: Type.Optional(count),
    idempotencyKey: Type.String({ minLength: 16, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$" }),
  },
  { additionalProperties: false },
);
export type MailChangeSelection = Static<typeof MailChangePreviewInput>;
export const MailChangeConfirmInput = Type.Object(
  {
    quoteId: Type.String({ minLength: 1, maxLength: 255, pattern: "^[A-Za-z0-9_-]+$" }),
    confirmRestart: Type.Literal(true),
  },
  { additionalProperties: false },
);
export const MailChangeCancelInput = Type.Object(
  { changeId: Type.String({ minLength: 1, maxLength: 255, pattern: "^[A-Za-z0-9_-]+$" }) },
  { additionalProperties: false },
);

export interface MailPlanAllowance {
  domains: number;
  recipients: number;
  mailboxes?: number;
  storageGB?: number;
}
export interface MailPlanChangeQuote extends BillingPlanChangeQuote {
  allowances: { current: MailPlanAllowance; next: MailPlanAllowance };
}
