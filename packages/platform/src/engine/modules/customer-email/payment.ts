import { z } from "zod";
import { diagnostics } from "@repo/core/diagnostics";
import { repos, type Database } from "@repo/db";
import { createCloudCustomerEmailRepo, type CustomerPaymentEmail } from "@repo/db/repos";
import { customerEmailId } from "./service";

const paid = z.object({
  paymentId: z.string().min(1).max(256),
  kind: z.enum(["subscription", "topup", "plan_change"]),
  amount: z.object({
    unitAmount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    currency: z.literal("usd"),
  }),
  namespace: z.string().optional(),
  metadata: z.object({ openship_organization: z.string().optional() }).optional(),
  offer: z.object({ billingMode: z.string().optional() }).optional(),
});

/** Called only after raw-body HMAC verification, persisted namespace ownership
 * resolution and provider entitlement synchronization. Never accepts a redirect. */
export async function prepareCustomerPaymentEmails(input: {
  organizationId: string;
  namespace: string;
  scope: "hosting" | "management";
  workspaceId?: string | null;
  eventType: string;
  data: unknown;
}) {
  if (!["payment.succeeded", "subscription.renewed"].includes(input.eventType)) return null;
  const parsed = paid.safeParse(input.data);
  if (!parsed.success) return null;
  const payment = parsed.data;
  if (
    (payment.namespace && payment.namespace !== input.namespace) ||
    (payment.metadata?.openship_organization &&
      payment.metadata.openship_organization !== input.organizationId)
  )
    throw new Error("Payment email ownership mismatch");
  const members = await repos.member.listByOrganization(input.organizationId);
  const owner = members.find((member) => member.role.split(",").includes("owner"));
  if (!owner) {
    diagnostics.warn(
      "platform/engine/modules/customer-email",
      "Payment email has no billing owner; billing processing continues.",
    );
    return null;
  }
  const workspace = input.workspaceId
    ? await repos.cloudWorkspace.findByIdInOrganization(input.workspaceId, input.organizationId)
    : null;
  const payload: CustomerPaymentEmail = {
    scope: input.scope,
    namespace: input.namespace,
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    paymentId: payment.paymentId,
    amountCents: payment.amount.unitAmount,
    currency: payment.amount.currency,
    productName:
      input.scope === "management"
        ? "OpenShip managed service"
        : `OpenShip Cloud${workspace?.name ? ` — ${workspace.name}` : ""}`,
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
