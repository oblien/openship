import { randomUUID } from "node:crypto";
import { AppError, safeErrorMessage } from "@repo/core";
import type { ActionDelivery, createActionsRepo } from "@repo/db";

type Repository = ReturnType<typeof createActionsRepo>;

/** GitHub does not automatically retry failed webhooks. A small durable inbox
 * owns delivery retries; accepted runs still use their own idempotent scheduler. */
export class ActionWebhookInbox {
  private readonly owner = `actions-delivery-${randomUUID()}`;
  constructor(
    private readonly ports: {
      repo: Repository;
      dispatch(delivery: ActionDelivery): Promise<void>;
      reportError(error: unknown, delivery: ActionDelivery): void;
    },
  ) {}

  async tick(now = new Date()): Promise<void> {
    const pending = await this.ports.repo.pendingDeliveries(now);
    for (let i = 0; i < pending.length; i += 4)
      await Promise.all(pending.slice(i, i + 4).map((row) => this.deliver(row, now)));
  }

  private async deliver(row: ActionDelivery, now: Date): Promise<void> {
    const { repo } = this.ports;
    const item = await repo.claimDelivery(row.organizationId, row.id, this.owner, now);
    if (!item) return;
    let lost = false;
    const timer = setInterval(() => {
      void repo
        .renewDelivery(item.organizationId, item.id, this.owner)
        .then((value) => {
          if (!value) lost = true;
        })
        .catch((error) => {
          lost = true;
          this.ports.reportError(error, item);
        });
    }, 30_000);
    timer.unref?.();
    try {
      await this.ports.dispatch(item);
      if (!lost) await repo.finishDelivery(item.organizationId, item.id, this.owner, null);
    } catch (error) {
      this.ports.reportError(error, item);
      const permanent =
        error instanceof AppError &&
        error.statusCode < 500 &&
        ![408, 429].includes(error.statusCode);
      const retry =
        !permanent && item.attempts < 10 && Date.now() - item.createdAt.getTime() < 86_400_000;
      if (!lost)
        await repo.finishDelivery(
          item.organizationId,
          item.id,
          this.owner,
          safeErrorMessage(error),
          retry
            ? new Date(Date.now() + Math.min(300_000, 5000 * 2 ** (item.attempts - 1)))
            : undefined,
        );
    } finally {
      clearInterval(timer);
    }
  }
}
