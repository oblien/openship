import { createHash, randomUUID } from "node:crypto";
import { SUPPORT_EMAIL } from "@repo/core";
import { z } from "zod";
import type { CloudCustomerEmailRepo, CustomerEmail, CustomerPaymentEmail } from "@repo/db/repos";
import type { SendMailOptions } from "../../lib/mail";
import { signupWelcome, purchaseWelcome, invoiceEmail } from "./templates";

export const customerEmailId = (key: string) => createHash("sha256").update(key).digest("hex");
export function customerBillingPath(payment: CustomerPaymentEmail, organizationId: string) {
  const query = new URLSearchParams({ organizationId });
  if (payment.workspaceId) query.set("workspaceId", payment.workspaceId);
  return `${payment.scope === "management" ? "/billing/manage" : "/billing/payment"}?${query}`;
}

export class CustomerEmailService {
  private flushing?: Promise<{ sent: number; failed: number; canceled: number }>;
  constructor(
    private readonly options: {
      enabled: () => boolean;
      repo: CloudCustomerEmailRepo;
      send: (input: SendMailOptions) => Promise<boolean>;
      dashboardUrl: string;
      now?: () => Date;
    },
  ) {}

  private now() {
    return this.options.now?.() ?? new Date();
  }
  private url(path: string) {
    return new URL(path, this.options.dashboardUrl).toString();
  }

  private async render(row: CustomerEmail): Promise<SendMailOptions | null | "unverified"> {
    const recipient = await this.options.repo.recipient(row.userId, row.organizationId);
    // Recheck ownership and verification immediately before sending. Deleting an
    // account, leaving an organization or changing email must not leak billing mail.
    if (recipient && !recipient.verified) return "unverified";
    if (
      !recipient ||
      recipient.autoProvisioned ||
      !recipient.role.split(",").includes("owner") ||
      !z.email().safeParse(recipient.email).success ||
      /@(?:users\.)?noreply\.github\.com$/i.test(recipient.email)
    )
      return null;
    const base = {
      to: recipient.email,
      preferSource: "auto" as const,
      messageId: `<customer-${customerEmailId(row.id)}@openship.io>`,
    };
    if (row.kind === "signup")
      return {
        ...base,
        customerSender: "support",
        replyTo: SUPPORT_EMAIL,
        ...signupWelcome(
          recipient.name,
          this.url("/"),
          this.url(
            `/billing/plans?newServer=1&organizationId=${encodeURIComponent(row.organizationId)}`,
          ),
        ),
      };
    if (!row.payment) throw new Error("Payment email is missing its receipt");
    const billingUrl = this.url(customerBillingPath(row.payment, row.organizationId));
    return row.kind === "purchase"
      ? {
          ...base,
          customerSender: "support",
          replyTo: SUPPORT_EMAIL,
          ...purchaseWelcome(
            recipient.name,
            row.payment,
            billingUrl.replace("/billing/payment?", "/billing/overview?"),
          ),
        }
      : {
          ...base,
          customerSender: "billing",
          ...invoiceEmail(recipient.name, row.payment, billingUrl),
        };
  }

  flush() {
    if (!this.options.enabled()) return Promise.resolve({ sent: 0, failed: 0, canceled: 0 });
    if (this.flushing) return this.flushing;
    this.flushing = this.deliver().finally(() => {
      this.flushing = undefined;
    });
    return this.flushing;
  }

  private async deliver() {
    const result = { sent: 0, failed: 0, canceled: 0 };
    for (let count = 0; count < 20; count++) {
      const leaseId = randomUUID();
      const row = await this.options.repo.claim(leaseId, this.now());
      if (!row) break;
      try {
        const mail = await this.render(row);
        if (mail === "unverified") {
          await this.options.repo.deferVerification(row.id, leaseId, this.now());
          continue;
        }
        if (!mail) {
          await this.options.repo.finish(row.id, leaseId, "canceled", this.now());
          result.canceled++;
          continue;
        }
        if (!(await this.options.send(mail))) throw new Error("SMTP is unavailable");
        await this.options.repo.finish(row.id, leaseId, "sent", this.now());
        result.sent++;
      } catch {
        // diagnostics-ignore: only normalized delivery state is persisted, never
        // SMTP credentials, payment links, addresses or provider error bodies.
        const next =
          row.attempts >= 12
            ? null
            : new Date(
                this.now().getTime() + Math.min(6 * 3600_000, 30_000 * 2 ** (row.attempts - 1)),
              );
        await this.options.repo.failed(row.id, leaseId, next);
        result.failed++;
      }
    }
    return result;
  }
}
