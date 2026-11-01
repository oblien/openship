import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { createHash, randomUUID } from "node:crypto";
import { AppError, ConflictError, NotFoundError, SUPPORT_EMAIL, ValidationError } from "@repo/core";
import {
  CloudSupportInputSchema,
  CloudSupportReplySchema,
  CloudSupportCustomerInputSchema,
  CloudSupportCustomerReplySchema,
  CloudSupportCustomerQuerySchema,
  CloudSupportCustomerStatusSchema,
  parseInput,
  type CloudSupportReceipt,
  type CloudSupportCustomerDetail,
  type CloudSupportCustomerList,
  type CloudSupportCustomerTicket,
  type CloudSupportSession,
} from "@repo/contracts";
import type { CloudSupportRepo, CloudSupportTicket } from "@repo/db/repos";
import type { ExecutionContext } from "../../../context";
import type { SendMailOptions } from "../../lib/mail";
import { supportEmail } from "../../lib/email-templates";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const receipt = (ticket: CloudSupportTicket): CloudSupportReceipt => ({
  id: ticket.id,
  createdAt: ticket.createdAt.toISOString(),
});
const customerTicket = (ticket: CloudSupportTicket): CloudSupportCustomerTicket => ({
  id: ticket.id,
  subject: ticket.subject,
  category: ticket.category,
  status: ticket.status,
  createdAt: ticket.createdAt.toISOString(),
  updatedAt: ticket.updatedAt.toISOString(),
});

export class CloudSupportService {
  private flushing?: Promise<{ delivered: number; failed: number }>;
  constructor(
    private readonly options: {
      enabled: () => boolean;
      repo: CloudSupportRepo;
      send: (mail: SendMailOptions) => Promise<boolean>;
    },
  ) {}

  private requireCloud() {
    if (!this.options.enabled()) throw new NotFoundError("Support");
  }

  private customer(ctx: ExecutionContext) {
    this.requireCloud();
    // Account support can contain private conversations unrelated to an
    // organization's infrastructure grants. API tokens never inherit access.
    // Cloud links carry a real Better Auth session as a server-side Bearer.
    // PAT/OAuth bearers are different principals and never inherit this access.
    if (
      !["cookie", "bearer"].includes(ctx.sessionKind) ||
      ctx.principalKind ||
      ctx.tokenScope ||
      ctx.credential ||
      !ctx.sessionId ||
      !ctx.userId ||
      ctx.user?.id !== ctx.userId
    )
      throw new AppError(
        "Sign in to Openship Cloud to manage your support tickets.",
        403,
        "SUPPORT_SESSION_REQUIRED",
      );
    return ctx.user;
  }

  assertCustomerAccount(ctx: ExecutionContext, expectedKey?: string) {
    const user = this.customer(ctx);
    if (expectedKey !== undefined && expectedKey !== user.id)
      throw new AppError(
        "Your support account changed. Reload Support before continuing.",
        409,
        "SUPPORT_ACCOUNT_CHANGED",
      );
  }

  sessionForCustomer(ctx: ExecutionContext): CloudSupportSession {
    const user = this.customer(ctx);
    return { account: { id: user.id, name: user.name, email: user.email, key: user.id } };
  }

  async submitForCustomer(
    ctx: ExecutionContext,
    raw: unknown,
    beforeCreate: (subject: string) => Promise<void>,
  ) {
    const user = this.customer(ctx);
    const input = parseInput(CloudSupportCustomerInputSchema, raw);
    const value = {
      subject: input.subject.trim(),
      message: input.message.trim(),
      category: input.category,
    };
    if (!value.subject || !value.message)
      throw new ValidationError("Subject and message cannot be blank.");
    const id = `SUP-${hash(`customer:${user.id}:${input.requestId.toLowerCase()}`).slice(0, 24).toUpperCase()}`;
    const inputHash = hash(JSON.stringify(value));
    const existing = await this.options.repo.findForUser(id, user.id);
    if (existing) {
      if (existing.inputHash !== inputHash)
        throw new ConflictError("This request reference was already used for a different message.");
      return receipt(existing);
    }
    await beforeCreate(hash(user.id));
    return receipt(
      await this.options.repo.create({
        id,
        inputHash,
        ...value,
        ownerUserId: user.id,
        name: user.name?.trim() || user.email,
        email: user.email,
        source: "support",
      }),
    );
  }

  async listForCustomer(ctx: ExecutionContext, raw: unknown): Promise<CloudSupportCustomerList> {
    const user = this.customer(ctx);
    const input = parseInput(CloudSupportCustomerQuerySchema, raw);
    const rows = await this.options.repo.list({ ...input, ownerUserId: user.id });
    const page = rows.slice(0, input.limit);
    return {
      tickets: page.map(customerTicket),
      nextCursor: rows.length > input.limit ? page.at(-1)!.id : null,
    };
  }

  async getForCustomer(ctx: ExecutionContext, id: string): Promise<CloudSupportCustomerDetail> {
    const user = this.customer(ctx);
    const ticket = await this.options.repo.findForUser(id, user.id);
    if (!ticket) throw new NotFoundError("Support ticket");
    const messages = await this.options.repo.messages(id);
    return {
      ticket: { ...customerTicket(ticket), message: ticket.message },
      // Mail receipts, delivery leases, SMTP errors and operator addresses are
      // not conversation content and never enter the customer response.
      messages: messages.flatMap((message) =>
        (message.kind === "reply" || message.kind === "customer_reply") && message.body
          ? [
              {
                id: message.id,
                author: message.kind === "reply" ? ("support" as const) : ("customer" as const),
                body: message.body,
                createdAt: message.createdAt.toISOString(),
              },
            ]
          : [],
      ),
    };
  }

  async replyForCustomer(
    ctx: ExecutionContext,
    id: string,
    raw: unknown,
    beforeCreate: (subject: string) => Promise<void>,
  ) {
    const user = this.customer(ctx);
    const input = parseInput(CloudSupportCustomerReplySchema, raw);
    const body = input.message.trim();
    if (!body) throw new ValidationError("Reply cannot be blank.");
    if (!(await this.options.repo.findForUser(id, user.id)))
      throw new NotFoundError("Support ticket");
    const messageId = `${id}:customer:${input.requestId.toLowerCase()}`;
    if (!(await this.options.repo.findMessage(id, messageId))) await beforeCreate(hash(user.id));
    await this.options.repo.reply(id, { id: messageId, body, resolve: false }, user.id);
    return this.getForCustomer(ctx, id);
  }

  async setStatusForCustomer(ctx: ExecutionContext, id: string, raw: unknown) {
    const user = this.customer(ctx);
    const { status } = parseInput(CloudSupportCustomerStatusSchema, raw);
    await this.options.repo.setStatus(id, status, user.id);
    return this.getForCustomer(ctx, id);
  }

  async submit(raw: unknown, beforeCreate: (recipientHash: string) => Promise<void>) {
    this.requireCloud();
    const input = parseInput(CloudSupportInputSchema, raw);
    const value = {
      name: input.name.trim(),
      email: input.email.trim(),
      subject: input.subject.trim(),
      message: input.message.trim(),
      source: input.source,
    };
    if (!value.name || !value.subject || !value.message)
      throw new ValidationError("Name, subject, and message cannot be blank.");
    const recipientHash = hash(value.email.toLowerCase());
    const id = `SUP-${hash(`${recipientHash}:${input.requestId.toLowerCase()}`).slice(0, 24).toUpperCase()}`;
    const inputHash = hash(JSON.stringify(value));
    const existing = await this.options.repo.find(id);
    if (existing) {
      if (existing.inputHash !== inputHash)
        throw new ConflictError("This request reference was already used for a different message.");
      return receipt(existing);
    }
    // Rate-limit NEW tickets only. A retry after a lost response remains safe.
    await beforeCreate(recipientHash);
    return receipt(await this.options.repo.create({ id, inputHash, ...value }));
  }

  async list(input: { status?: CloudSupportTicket["status"]; before?: string; limit: number }) {
    this.requireCloud();
    const rows = await this.options.repo.list(input);
    const page = rows.slice(0, input.limit);
    return {
      tickets: page.map(({ inputHash: _inputHash, message: _message, ...ticket }) => ticket),
      nextCursor: rows.length > input.limit ? page.at(-1)!.id : null,
    };
  }

  async get(id: string) {
    this.requireCloud();
    const ticket = await this.options.repo.find(id);
    if (!ticket) throw new NotFoundError("Support ticket");
    const { inputHash: _inputHash, ...view } = ticket;
    return { ticket: view, messages: await this.options.repo.messages(id) };
  }

  async setStatus(id: string, status: CloudSupportTicket["status"]) {
    this.requireCloud();
    await this.options.repo.setStatus(id, status);
  }

  async reply(id: string, raw: unknown) {
    this.requireCloud();
    const input = parseInput(CloudSupportReplySchema, raw);
    const body = input.message.trim();
    if (!body) throw new ValidationError("Reply cannot be blank.");
    return this.options.repo.reply(id, {
      id: `${id}:reply:${input.requestId.toLowerCase()}`,
      body,
      resolve: input.resolve,
    });
  }

  async retry(id: string) {
    this.requireCloud();
    if (!(await this.options.repo.find(id))) throw new NotFoundError("Support ticket");
    return { queued: (await this.options.repo.retryFailed(id)).length };
  }

  /** Bounded batches, with SQL leases shared by all Cloud API replicas. */
  flush(): Promise<{ delivered: number; failed: number }> {
    if (!this.options.enabled()) return Promise.resolve({ delivered: 0, failed: 0 });
    return (this.flushing ??= this.deliverPending().finally(() => {
      this.flushing = undefined;
    }));
  }

  private async deliverPending() {
    const summary = { delivered: 0, failed: 0 };
    for (let batch = 0; batch < 5; batch++) {
      const leaseId = randomUUID();
      const due = await this.options.repo.claim(leaseId, new Date(), 4);
      if (!due.length) break;
      await Promise.all(
        due.map(async (message) => {
          try {
            const ticket = await this.options.repo.find(message.ticketId);
            if (!ticket) throw new NotFoundError("Support ticket");
            const accepted = await this.options.send({
              to:
                message.kind === "notification" || message.kind === "customer_reply"
                  ? SUPPORT_EMAIL
                  : ticket.email,
              replyTo:
                message.kind === "notification" || message.kind === "customer_reply"
                  ? ticket.email
                  : SUPPORT_EMAIL,
              messageId: `<support-${hash(message.id)}@openship.io>`,
              ...supportEmail({ ...ticket, kind: message.kind, reply: message.body }),
            });
            if (!accepted)
              throw new AppError(
                "No mail transport accepted this message",
                503,
                "SMTP_UNAVAILABLE",
              );
            await this.options.repo.delivered(message.id, leaseId, new Date());
            summary.delivered++;
          } catch (error) {
            observeCaughtError(error, "platform/engine/modules/cloud-support/service");
            // SMTP errors may contain credentials/addresses. Persist only a safe
            // operational diagnosis, never the provider's raw response.
            const reason =
              error instanceof AppError && error.code === "SMTP_UNAVAILABLE"
                ? "No configured mail transport accepted this email. Check Cloud SMTP settings."
                : "Email delivery failed. Check Cloud SMTP settings and retry delivery.";
            const delay = Math.min(60 * 60_000, 60_000 * 2 ** Math.min(message.attempts - 1, 6));
            await this.options.repo.failed(
              message.id,
              leaseId,
              message.attempts >= 10 ? null : new Date(Date.now() + delay),
              reason,
            );
            summary.failed++;
          }
        }),
      );
    }
    return summary;
  }
}
