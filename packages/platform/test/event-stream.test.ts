import { expect, it, vi } from "vitest";
import { subscriptionEvents } from "../src/event-stream";

it("releases a subscription when an idle event read is aborted", async () => {
  const abort = new AbortController();
  const unsubscribe = vi.fn();
  const subscribed = Promise.withResolvers<void>();
  const stream = subscriptionEvents(() => { subscribed.resolve(); return { success: true, unsubscribe }; }, abort.signal);
  const pending = stream.next();
  await subscribed.promise;
  abort.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(unsubscribe).toHaveBeenCalledOnce();
});

it("bounds a synchronous replay and releases its source after backpressure", async () => {
  const unsubscribe = vi.fn();
  const stream = subscriptionEvents(write => {
    for (let i = 0; i < 20_000; i++) if (!write("log", "entry")) break;
    return { success: true, unsubscribe };
  });
  await expect(stream.next()).rejects.toMatchObject({ code: "EVENT_BACKPRESSURE" });
  expect(unsubscribe).toHaveBeenCalledOnce();
});

it("retains a durable log cursor and terminal event through replay", async () => {
  const unsubscribe = vi.fn();
  const events = [];
  for await (const event of subscriptionEvents(write => {
    write("log", JSON.stringify({ eventId: 12, message: "ready" }));
    write("end", "{}");
    return { success: true, unsubscribe };
  })) events.push(event);
  expect(events).toEqual([{ event: "log", id: "12", data: JSON.stringify({ eventId: 12, message: "ready" }) }, { event: "end", data: "{}" }]);
  expect(unsubscribe).toHaveBeenCalledOnce();
});
