import { z } from "zod";
import { diagnostics } from "@repo/core/diagnostics";
import { repos, type Database } from "@repo/db";
import {
  createCloudCustomerEmailRepo,
  type CustomerPaymentEmail,
  type CustomerCancellationEmail,
} from "@repo/db/repos";
import type { OblienSubscription } from "../../lib/oblien-billing-api";
import { customerEmailId } from "./service";
import { subscriptionCancellation } from "./cancellation";

const ownershipSchema = z.object({
  namespace: z.string().optional(),
  metadata: z.object({ openship_organization: z.string().optional() }).optional(),
});
const paid = ownershipSchema.extend({
  paymentId: z.string().min(1).max(256),
  kind: z.enum(["subscription", "topup", "plan_change"]),
  amount: z.object({
    unitAmount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    currency: z.literal("usd"),
  }),
  offer: z.object({ billingMode: z.string().optional() }).optional(),
});

/** Called only after raw-body HMAC verification, persisted namespace ownership
 * resolution and provider entitlement synchronization. Never accepts a redirect. */
export async function prepareCustomerBillingEmails(input: {
  organizationId: string;
  namespace: string;
  scope: "hosting" | "management";
  workspaceId?: string | null;
  eventType: string;
  data: unknown;
  subscription?: OblienSubscription;
}) {
  const cancellationEvent = ["subscription.updated", "subscription.canceled"].includes(
    input.eventType,
  );
  const cancellation = cancellationEvent
    ? subscriptionCancellation(input.subscription ?? null)
    : null;
  if (!cancellation && !["payment.succeeded", "subscription.renewed"].includes(input.eventType))
    return null;
  const parsed = paid.safeParse(input.data);
  if (!cancellation && !parsed.success) return null;
  const payment = parsed.success ? parsed.data : null;
  const ownership = ownershipSchema.parse(input.data ?? {});
  if (
    (ownership.namespace && ownership.namespace !== input.namespace) ||
    (ownership.metadata?.openship_organization &&
      ownership.metadata.openship_organization !== input.organizationId)
  )
    throw new Error("Billing email ownership mismatch");
  const members = await repos.member.listByOrganization(input.organizationId);
  const owner = members.find((member) => member.role.split(",").includes("owner"));
  if (!owner) {
    diagnostics.warn(
      "platform/engine/modules/customer-email",
      "Billing email has no billing owner; billing processing continues.",
    );
    return null;
  }
  const workspace = input.workspaceId
    ? await repos.cloudWorkspace.findByIdInOrganization(input.workspaceId, input.organizationId)
    : null;
  const scope = {
    scope: input.scope,
    namespace: input.namespace,
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    productName:
      input.scope === "management"
        ? "OpenShip managed service"
        : `OpenShip Cloud${workspace?.name ? ` — ${workspace.name}` : ""}`,
  };
  if (cancellation) {
    const payload: CustomerCancellationEmail = { ...scope, ...cancellation };
    return async (tx: Database) =>
      createCloudCustomerEmailRepo(tx).enqueue({
        id: customerEmailId(`cancellation:${input.namespace}:${cancellation.canceledAt}`),
        kind: "cancellation",
        userId: owner.userId,
        organizationId: input.organizationId,
        cancellation: payload,
      });
  }
  if (!payment) return null;
  const payload: CustomerPaymentEmail = {
    ...scope,
    paymentId: payment.paymentId,
    amountCents: payment.amount.unitAmount,
    currency: payment.amount.currency,
  };
  return async (tx: Database) => {
    const repo = createCloudCustomerEmailRepo(tx);
    const identity = {
      userId: owner.userId,
      organizationId: input.organizationId,
      payment: payload,
    };
    await repo.enqueue({
      ...identity,
      kind: "invoice",
      id: customerEmailId(`invoice:${input.namespace}:${payment.paymentId}`),
    });
    if (
      input.eventType === "payment.succeeded" &&
      (payment.kind === "subscription" ||
        (input.scope === "management" &&
          payment.kind === "topup" &&
          payment.offer?.billingMode === "service"))
    )
      await repo.enqueue({
        ...identity,
        kind: "purchase",
        id: customerEmailId(`purchase:${input.namespace}`),
      });
  };
}
