import { beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { db, repos, schema, seedOwner } from "../jobs/_harness";
import { closeDb, eq } from "@repo/db";
import type { Database } from "@repo/db";
import type { OblienSubscription } from "@repo/platform/engine/lib/oblien-billing-api";
import { CustomerEmailService } from "@repo/platform/engine/modules/customer-email/service";
import { prepareCustomerBillingEmails } from "@repo/platform/engine/modules/customer-email/billing";
import { provisionUser } from "@repo/platform/engine/lib/provision-user";
import {
  signupWelcome,
  purchaseWelcome,
  invoiceEmail,
  cancellationEmail,
} from "@repo/platform/engine/modules/customer-email/templates";

let now: Date;
const send = vi.fn();
const readSubscription = vi.fn<(namespace: string) => Promise<OblienSubscription>>();
const worker = (enabled = true) =>
  new CustomerEmailService({
    enabled: () => enabled,
    repo: repos.cloudCustomerEmail,
    send,
    readSubscription,
    dashboardUrl: "https://app.openship.io",
    now: () => now,
  });
const rows = () => db.select().from(schema.cloudCustomerEmail);
async function fixture() {
  const owner = await seedOwner();
  const workspace = await repos.cloudWorkspace.create({
    organizationId: owner.orgId,
    name: "Production",
  });
  const namespace = `ns-${workspace.id}`;
  await repos.cloudWorkspace.setNamespace(workspace.id, owner.orgId, namespace);
  return { ...owner, workspace, namespace };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const event = (f: Fixture, extra = {}) => ({
  organizationId: f.orgId,
  namespace: f.namespace,
  scope: "hosting" as const,
  workspaceId: f.workspace.id,
  eventType: "payment.succeeded",
  data: {
    namespace: f.namespace,
    paymentId: "in_initial",
    kind: "subscription",
    amount: { unitAmount: 2400, currency: "usd" },
    metadata: { openship_organization: f.orgId },
  },
  ...extra,
});
async function commit(input: Parameters<typeof prepareCustomerBillingEmails>[0]) {
  const enqueue = await prepareCustomerBillingEmails(input);
  if (enqueue) await db.transaction((tx) => enqueue(tx as unknown as Database));
}
beforeEach(async () => {
  now = new Date(Date.now() + 60_000);
  await db.delete(schema.cloudCustomerEmail);
  send.mockReset().mockResolvedValue(true);
  readSubscription.mockReset().mockResolvedValue(null);
});
afterAll(() => closeDb());

describe("Cloud customer email delivery with real SQL", () => {
  it("queues signup atomically, waits for verification and sends only once across restarts", async () => {
    const id = randomUUID();
    const signup = {
      id,
      name: "Alex",
      email: "alex@example.com",
      emailVerified: false,
      welcomeEmail: true,
    };
    await provisionUser(signup);
    expect(await rows()).toMatchObject([
      { userId: id, kind: "signup", attempts: 0, status: "pending" },
    ]);
    expect(await worker().flush()).toEqual({ sent: 0, failed: 0, canceled: 0 });
    expect(send).not.toHaveBeenCalled();
    await db.update(schema.user).set({ emailVerified: true }).where(eq(schema.user.id, id));
    expect(await worker().flush()).toMatchObject({ sent: 1 });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: signup.email,
        customerSender: "support",
        replyTo: "support@openship.io",
        subject: "Welcome to OpenShip",
        messageId: expect.stringContaining("@openship.io>"),
      }),
    );
    expect(send.mock.calls[0][0].text).toContain("explore OpenShip Cloud whenever you're ready");
    await provisionUser(signup);
    await worker().flush();
    expect(send).toHaveBeenCalledOnce();
  });

  it("rolls signup mail back with its account bootstrap and does not backfill existing accounts", async () => {
    await seedOwner();
    expect(await rows()).toEqual([]);
    const id = randomUUID();
    // The deliberately failing outer transaction proves the mail and bootstrap
    // share one commit, rather than creating a send before the account exists.
    const { provisionUserInTransaction } = await import("@repo/platform/engine/lib/provision-user");
    await expect(
      db.transaction(async (tx) => {
        await provisionUserInTransaction(tx as never, {
          id,
          name: "Rollback",
          email: "rollback@example.com",
          welcomeEmail: true,
        });
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect(await rows()).toEqual([]);
    expect(await repos.user.findById(id)).toBeUndefined();
  });

  it("does not enqueue welcome mail for desktop mirrors or auto-provisioned identities", async () => {
    await provisionUser({
      id: randomUUID(),
      name: "Local",
      email: "local@example.com",
      emailVerified: true,
    });
    await provisionUser({
      id: randomUUID(),
      name: "Local",
      email: "auto@example.com",
      welcomeEmail: true,
      autoProvisioned: true,
    });
    expect(await rows()).toEqual([]);
  });

  it("sends a separate purchase welcome and invoice, deduplicated by namespace and payment", async () => {
    const f = await fixture();
    await Promise.all(Array.from({ length: 4 }, () => commit(event(f))));
    expect(await rows()).toHaveLength(2);
    await worker().flush();
    expect(send).toHaveBeenCalledTimes(2);
    const invoice = send.mock.calls
      .map(([mail]) => mail)
      .find((mail) => mail.customerSender === "billing");
    const welcome = send.mock.calls
      .map(([mail]) => mail)
      .find((mail) => mail.customerSender === "support");
    expect(invoice.subject).toBe("Your OpenShip invoice — $24.00");
    expect(invoice.replyTo).toBeUndefined();
    expect(invoice.text).toContain(
      `/billing/payment?organizationId=${f.orgId}&workspaceId=${f.workspace.id}`,
    );
    expect(invoice.text).toContain("Payment reference: in_initial");
    expect(welcome.replyTo).toBe("support@openship.io");
    expect(welcome.text).toContain("just reply");
    expect(welcome.text).not.toContain("server is ready");
    await commit(event(f));
    await worker().flush();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("queues an invoice for each renewal, without repeating the purchase welcome", async () => {
    const f = await fixture();
    await commit(event(f));
    const data = { ...event(f).data, paymentId: "in_renewal" };
    await commit(event(f, { eventType: "subscription.renewed", data }));
    await commit(event(f, { eventType: "subscription.renewed", data }));
    expect((await rows()).map((row) => row.kind).sort()).toEqual([
      "invoice",
      "invoice",
      "purchase",
    ]);
  });

  it("rolls email and the webhook checkpoint back together when processing cannot commit", async () => {
    const f = await fixture();
    const enqueue = await prepareCustomerBillingEmails(event(f));
    const id = randomUUID();
    await expect(
      db.transaction(async (tx) => {
        await enqueue!(tx as unknown as Database);
        await tx
          .insert(schema.oblienWebhookEvent)
          .values({ oblienEventId: id, eventType: "payment.succeeded", processedAt: now });
        throw new Error("checkpoint failed");
      }),
    ).rejects.toThrow("checkpoint failed");
    expect(await rows()).toEqual([]);
    expect(
      await db
        .select()
        .from(schema.oblienWebhookEvent)
        .where(eq(schema.oblienWebhookEvent.oblienEventId, id)),
    ).toEqual([]);
    await commit(event(f));
    expect(await rows()).toHaveLength(2);
  });

  it("keeps receipts independent across organizations and never trusts recipient metadata", async () => {
    const a = await fixture();
    const b = await fixture();
    await commit(event(a));
    await commit(event(b, { data: { ...event(b).data, email: "attacker@example.com" } }));
    await worker().flush();
    expect(new Set(send.mock.calls.map(([mail]) => mail.to))).toEqual(
      new Set([
        (await repos.user.findById(a.userId))!.email,
        (await repos.user.findById(b.userId))!.email,
      ]),
    );
    await expect(
      commit(event(a, { data: { ...event(a).data, namespace: b.namespace } })),
    ).rejects.toThrow("ownership mismatch");
    await expect(
      commit(
        event(a, { data: { ...event(a).data, metadata: { openship_organization: b.orgId } } }),
      ),
    ).rejects.toThrow("ownership mismatch");
  });

  it("welcomes each independent server purchase in the same organization", async () => {
    const a = await fixture();
    const workspace = await repos.cloudWorkspace.create({
      organizationId: a.orgId,
      name: "Second server",
    });
    const b = { ...a, workspace, namespace: `ns-${workspace.id}` };
    await repos.cloudWorkspace.setNamespace(workspace.id, a.orgId, b.namespace);
    await commit(event(a));
    await commit(event(b, { data: { ...event(b).data, paymentId: "in_second" } }));
    expect((await rows()).map((mail) => mail.kind).sort()).toEqual([
      "invoice",
      "invoice",
      "purchase",
      "purchase",
    ]);
  });

  it.each(["entitlement.changed", "subscription.updated", "credits.usage"])(
    "does not mistake %s for a payment",
    async (eventType) => {
      const f = await fixture();
      await commit(event(f, { eventType }));
      expect(await rows()).toEqual([]);
    },
  );

  it.each([
    {},
    { paymentId: "in_wrong", kind: "subscription", amount: { unitAmount: -1, currency: "usd" } },
    { paymentId: "in_wrong", kind: "subscription", amount: { unitAmount: 2400, currency: "eur" } },
  ])("does not invent an invoice from invalid payment details", async (data) => {
    const f = await fixture();
    await commit(event(f, { data }));
    expect(await rows()).toEqual([]);
  });

  it("welcomes a one-time managed-service purchase and uses its separate billing account", async () => {
    const f = await fixture();
    const input = event(f, {
      scope: "management",
      workspaceId: undefined,
      data: {
        ...event(f).data,
        paymentId: "cs_one_time",
        kind: "topup",
        offer: { billingMode: "service" },
      },
    });
    await commit(input);
    await worker().flush();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.find(([mail]) => mail.customerSender === "billing")![0].text).toContain(
      `/billing/manage?organizationId=${f.orgId}`,
    );
    expect(
      send.mock.calls.find(([mail]) => mail.customerSender === "billing")![0].subject,
    ).toContain("receipt");
  });

  it.each(["topup", "plan_change"])(
    "emails the actual amount paid for %s without sending a new welcome",
    async (kind) => {
      const f = await fixture();
      await commit(
        event(f, {
          data: {
            ...event(f).data,
            kind,
            paymentId: "in_discounted",
            amount: { unitAmount: 1250, currency: "usd" },
            offer: { unitAmount: 9900, billingMode: "payg" },
          },
        }),
      );
      await worker().flush();
      expect(send).toHaveBeenCalledOnce();
      expect(send.mock.calls[0][0]).toMatchObject({
        customerSender: "billing",
        subject: "Your OpenShip invoice — $12.50",
      });
    },
  );

  it("retries SMTP failures after a restart with the same message identity and bounded attempts", async () => {
    const f = await fixture();
    await commit(event(f, { eventType: "subscription.renewed" }));
    send.mockRejectedValue(new Error("secret SMTP credential and customer email"));
    const attempts: string[] = [];
    for (let i = 0; i < 12; i++) {
      await worker().flush();
      attempts.push(send.mock.calls.at(-1)![0].messageId);
      now = new Date(now.getTime() + 7 * 3600_000);
    }
    expect(new Set(attempts).size).toBe(1);
    expect(await rows()).toMatchObject([
      {
        status: "failed",
        attempts: 12,
        nextAttemptAt: null,
        lastError: "Customer email delivery failed",
      },
    ]);
    await worker().flush();
    expect(send).toHaveBeenCalledTimes(12);
  });

  it("reclaims an abandoned lease and keeps an older worker from completing a newer delivery", async () => {
    const f = await fixture();
    await commit(event(f, { eventType: "subscription.renewed" }));
    const first = await repos.cloudCustomerEmail.claim("old", now);
    expect(await repos.cloudCustomerEmail.claim("other", now)).toBeNull();
    now = new Date(now.getTime() + 6 * 60_000);
    expect(await repos.cloudCustomerEmail.claim("new", now)).toMatchObject({
      id: first!.id,
      leaseId: "new",
    });
    await repos.cloudCustomerEmail.finish(first!.id, "old", "sent", now);
    expect(await rows()).toMatchObject([{ status: "pending", leaseId: "new" }]);
  });

  it("serializes concurrent flush calls and does not send while self-hosted", async () => {
    const f = await fixture();
    await commit(event(f));
    await worker(false).flush();
    expect(send).not.toHaveBeenCalled();
    const one = worker();
    await Promise.all([one.flush(), one.flush(), worker().flush()]);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("uses the current verified address, and cancels mail if billing access was removed", async () => {
    const f = await fixture();
    await commit(event(f));
    await db
      .update(schema.user)
      .set({ email: "new-address@example.com" })
      .where(eq(schema.user.id, f.userId));
    await worker().flush();
    expect(send.mock.calls.every(([mail]) => mail.to === "new-address@example.com")).toBe(true);
    send.mockClear();
    await commit(
      event(f, {
        eventType: "subscription.renewed",
        data: { ...event(f).data, paymentId: "in_later" },
      }),
    );
    await db.delete(schema.member).where(eq(schema.member.userId, f.userId));
    expect(await worker().flush()).toMatchObject({ canceled: 1 });
    expect(send).not.toHaveBeenCalled();
  });

  it("defers without spending a retry if email becomes unverified after a claim", async () => {
    const f = await fixture();
    await commit(event(f, { eventType: "subscription.renewed" }));
    const recipient = await repos.cloudCustomerEmail.recipient(f.userId, f.orgId);
    const lookup = vi
      .spyOn(repos.cloudCustomerEmail, "recipient")
      .mockResolvedValueOnce({ ...recipient!, verified: false });
    await worker().flush();
    expect(send).not.toHaveBeenCalled();
    expect(await rows()).toMatchObject([{ status: "pending", attempts: 0 }]);
    lookup.mockRestore();
    now = new Date(now.getTime() + 2 * 60_000);
    await worker().flush();
    expect(send).toHaveBeenCalledOnce();
  });

  it("removes private queued mail with a deleted account", async () => {
    const f = await fixture();
    await commit(event(f));
    await repos.user.delete(f.userId);
    expect(await rows()).toEqual([]);
  });

  it("escapes user-controlled names, product labels, references and link attributes", () => {
    const payment = {
      scope: "hosting" as const,
      namespace: "ns",
      paymentId: 'in_<script>"',
      amountCents: 2400,
      currency: "usd" as const,
      productName: "<img src=x onerror=alert(1)>",
    };
    const url = "https://app.openship.io/billing/payment?organizationId=a&workspaceId=b";
    for (const mail of [
      signupWelcome("<script>", url, url),
      purchaseWelcome("<script>", payment, url),
      invoiceEmail("<script>", payment, url),
      cancellationEmail(
        "<script>",
        {
          ...payment,
          canceledAt: now.toISOString(),
          endsAt: null,
        },
        url,
        now,
      ),
    ]) {
      expect(mail.html).not.toContain("<script>");
      expect(mail.html).not.toContain("<img src=x");
      expect(mail.html).toContain("&amp;workspaceId");
    }
  });
});

const subscription = (
  extra: Partial<NonNullable<OblienSubscription>> = {},
): NonNullable<OblienSubscription> => ({
  tierId: "capacity",
  status: "active",
  billingInterval: "monthly",
  periodStart: new Date(now.getTime() - 86400_000).toISOString(),
  periodEnd: new Date(now.getTime() + 30 * 86400_000).toISOString(),
  cancelAtPeriodEnd: true,
  canceledAt: new Date(now.getTime() - 3600_000).toISOString(),
  ...extra,
});
const cancellationEvent = (f: Fixture, extra = {}) =>
  event(f, {
    eventType: "subscription.updated",
    subscription: subscription(),
    data: { namespace: f.namespace, metadata: { openship_organization: f.orgId } },
    ...extra,
  });

describe("subscription cancellation email", () => {
  it("confirms the scoped end date and asks for feedback once across repeated provider events", async () => {
    const f = await fixture();
    const current = subscription();
    readSubscription.mockResolvedValue(current);
    await Promise.all(Array.from({ length: 4 }, () => commit(cancellationEvent(f))));
    await commit(cancellationEvent(f, { eventType: "subscription.canceled" }));
    expect(await rows()).toMatchObject([
      {
        kind: "cancellation",
        status: "pending",
        cancellation: {
          namespace: f.namespace,
          canceledAt: current.canceledAt,
          endsAt: current.periodEnd,
        },
      },
    ]);
    expect(await worker().flush()).toEqual({ sent: 1, failed: 0, canceled: 0 });
    expect(readSubscription).toHaveBeenCalledExactlyOnceWith(f.namespace);
    const mail = send.mock.calls[0][0];
    expect(mail).toMatchObject({
      to: (await repos.user.findById(f.userId))!.email,
      customerSender: "support",
      replyTo: "support@openship.io",
      subject: "Your OpenShip subscription update",
    });
    expect(mail.text).toContain("Renewal has been canceled for OpenShip Cloud — Production");
    expect(mail.text).toContain("UTC");
    expect(mail.text).toContain("What worked well, and what could we do better?");
    expect(mail.text).toContain("just reply");
    expect(mail.text).toContain(
      `/billing/payment?organizationId=${f.orgId}&workspaceId=${f.workspace.id}`,
    );
    expect(mail.text).not.toContain("has ended");
    await commit(
      cancellationEvent(f, {
        eventType: "subscription.canceled",
        subscription: { ...current, status: "canceled", cancelAtPeriodEnd: false },
      }),
    );
    await worker().flush();
    expect(send).toHaveBeenCalledOnce();
  });

  it.each([
    { cancelAtPeriodEnd: false, canceledAt: null },
    { canceledAt: null },
    { canceledAt: "invalid" },
    { periodEnd: null },
    { periodEnd: "invalid" },
  ])("does not trust an old cancellation event or invent dates: %j", async (changes) => {
    const f = await fixture();
    await commit(
      cancellationEvent(f, {
        eventType: "subscription.canceled",
        subscription: subscription(changes),
        data: { namespace: f.namespace, cancelAtPeriodEnd: true, endsAt: "2099-01-01" },
      }),
    );
    expect(await rows()).toEqual([]);
  });

  it.each(["resumed", "replaced", "missing"])(
    "suppresses queued mail when the subscription is %s",
    async (state) => {
      const f = await fixture();
      await commit(cancellationEvent(f));
      readSubscription.mockResolvedValue(
        state === "missing"
          ? null
          : subscription(
              state === "resumed"
                ? { cancelAtPeriodEnd: false, canceledAt: null }
                : { canceledAt: now.toISOString() },
            ),
      );
      expect(await worker().flush()).toEqual({ sent: 0, failed: 0, canceled: 1 });
      expect(send).not.toHaveBeenCalled();
      expect(await rows()).toMatchObject([{ status: "canceled" }]);
    },
  );

  it("rechecks delayed deliveries, retries provider failures and reports an already ended subscription accurately", async () => {
    const f = await fixture();
    const current = subscription();
    await commit(cancellationEvent(f));
    readSubscription.mockRejectedValueOnce(new Error("provider unavailable"));
    expect(await worker().flush()).toEqual({ sent: 0, failed: 1, canceled: 0 });
    expect(send).not.toHaveBeenCalled();
    expect(await rows()).toMatchObject([{ status: "pending", attempts: 1 }]);
    now = new Date(now.getTime() + 32 * 86400_000);
    readSubscription.mockResolvedValue({
      ...current,
      status: "canceled",
      cancelAtPeriodEnd: false,
    });
    expect(await worker().flush()).toMatchObject({ sent: 1 });
    expect(send.mock.calls[0][0].text).toContain(
      "Your subscription to OpenShip Cloud — Production has ended.",
    );
    expect(send.mock.calls[0][0].text).not.toContain("scheduled to end");
  });

  it("uses the latest period end and can confirm a new cancellation after resumption", async () => {
    const f = await fixture();
    await commit(cancellationEvent(f));
    readSubscription.mockResolvedValue(subscription({ periodEnd: "2099-12-31T12:00:00Z" }));
    await worker().flush();
    expect(send.mock.calls[0][0].text).toContain("December 31, 2099 at 12:00 PM UTC");
    const next = subscription({ canceledAt: now.toISOString() });
    await commit(cancellationEvent(f, { subscription: next }));
    readSubscription.mockResolvedValue(next);
    await worker().flush();
    expect(send).toHaveBeenCalledTimes(2);
    expect(new Set(send.mock.calls.map(([mail]) => mail.messageId)).size).toBe(2);
  });

  it("keeps cancellation private to the current owner and the confirmed namespace", async () => {
    const a = await fixture(),
      b = await fixture();
    await expect(
      commit(cancellationEvent(a, { data: { namespace: b.namespace } })),
    ).rejects.toThrow("ownership mismatch");
    await expect(
      commit(cancellationEvent(a, { data: { metadata: { openship_organization: b.orgId } } })),
    ).rejects.toThrow("ownership mismatch");
    await commit(cancellationEvent(a));
    await commit(cancellationEvent(b));
    expect(await rows()).toHaveLength(2);
    await db.delete(schema.member).where(eq(schema.member.userId, a.userId));
    readSubscription.mockResolvedValue(subscription());
    expect(await worker().flush()).toEqual({ sent: 1, failed: 0, canceled: 1 });
    expect(readSubscription).toHaveBeenCalledExactlyOnceWith(b.namespace);
    expect(send.mock.calls[0][0].to).toBe((await repos.user.findById(b.userId))!.email);
  });

  it("uses Manage billing for a managed-service cancellation without affecting sibling Cloud plans", async () => {
    const f = await fixture();
    await commit(cancellationEvent(f, { scope: "management", workspaceId: undefined }));
    readSubscription.mockResolvedValue(subscription());
    await worker().flush();
    expect(send.mock.calls[0][0].text).toContain("OpenShip managed service");
    expect(send.mock.calls[0][0].text).toContain(`/billing/manage?organizationId=${f.orgId}`);
    expect(send.mock.calls[0][0].text).not.toContain("workspaceId=");
  });

  it("confirms cancellations of independent workspaces in the same account separately", async () => {
    const a = await fixture();
    const workspace = await repos.cloudWorkspace.create({
      organizationId: a.orgId,
      name: "Staging",
    });
    const b = { ...a, workspace, namespace: `ns-${workspace.id}` };
    await repos.cloudWorkspace.setNamespace(workspace.id, a.orgId, b.namespace);
    await commit(cancellationEvent(a));
    await commit(cancellationEvent(b));
    readSubscription.mockResolvedValue(subscription());
    expect(await worker().flush()).toMatchObject({ sent: 2 });
    expect(send.mock.calls.map(([mail]) => mail.text)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`workspaceId=${a.workspace.id}`),
        expect.stringContaining(`workspaceId=${b.workspace.id}`),
      ]),
    );
  });

  it("commits cancellation mail with its webhook checkpoint, never before it", async () => {
    const f = await fixture();
    const enqueue = await prepareCustomerBillingEmails(cancellationEvent(f));
    await expect(
      db.transaction(async (tx) => {
        await enqueue!(tx as unknown as Database);
        throw new Error("checkpoint failed");
      }),
    ).rejects.toThrow("checkpoint failed");
    expect(await rows()).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });
});
