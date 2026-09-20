import { AppError } from "@repo/core";
import type { DeploymentEvent } from "@repo/contracts";

export interface EventSubscriptionHandle {
  success: boolean;
  unsubscribe(): void | Promise<void>;
}
export type EventSubscription = (
  write: (event: string, data: string) => boolean,
) => EventSubscriptionHandle | Promise<EventSubscriptionHandle>;

/** Adapt an existing push source into an owned, bounded, cancellable iterator. */
export async function* subscriptionEvents(
  subscribe: EventSubscription,
  signal?: AbortSignal,
  terminalEvent = "end",
): AsyncGenerator<DeploymentEvent> {
  signal?.throwIfAborted();
  const queue: DeploymentEvent[] = [];
  let queuedBytes = 0;
  let closed = false;
  let failure: Error | undefined;
  let wake: (() => void) | undefined;
  const abort = () => wake?.();
  signal?.addEventListener("abort", abort, { once: true });
  let subscription: EventSubscriptionHandle | undefined;
  try {
    subscription = await subscribe((event, data) => {
      if (closed || signal?.aborted) return false;
      // A slow subscriber must not consume unbounded memory. The durable
      // deployment/status/log operations remain available for reconciliation.
      if (queue.length >= 16_384 || queuedBytes + data.length > 16 * 1024 * 1024) {
        failure = new AppError(
          "Event consumer fell behind; resume from the last cursor",
          409,
          "EVENT_BACKPRESSURE",
        );
        closed = true;
        wake?.();
        return false;
      }
      let id: string | undefined;
      if (event === "log") {
        try {
          const payload: unknown = JSON.parse(data);
          if (
            payload &&
            typeof payload === "object" &&
            "eventId" in payload &&
            typeof payload.eventId === "number" &&
            Number.isSafeInteger(payload.eventId)
          )
            id = String(payload.eventId);
        } catch {
          /* Raw events retain their existing data. */
        }
      }
      queue.push({ event, data, ...(id !== undefined && { id }) });
      queuedBytes += data.length;
      if (event === terminalEvent) closed = true;
      wake?.();
      return true;
    });
    if (!subscription.success && !failure) {
      yield { event: "error", data: JSON.stringify({ error: "Session not found" }) };
      return;
    }
    while (true) {
      signal?.throwIfAborted();
      if (failure) throw failure;
      const event = queue.shift();
      if (event) {
        queuedBytes -= event.data.length;
        yield event;
      } else if (closed) return;
      else
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
    }
  } finally {
    closed = true;
    signal?.removeEventListener("abort", abort);
    await subscription?.unsubscribe();
    queue.length = 0;
  }
}
