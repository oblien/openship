import { AppError, type DeploymentEvent } from "@repo/contracts";
import { subscriptionEvents } from "../../event-stream";
import type { RunBus } from "./run-bus";

/** Subscribe before reading the durable snapshot, with bounded buffering and owned cleanup. */
export function runEvents<E extends { type: string }, Row>(options: {
  bus: RunBus<E>;
  id: string;
  load(): Promise<Row>;
  snapshot(row: Row): E;
  complete(row: Row): E | null;
  present?(event: E): unknown;
  signal?: AbortSignal;
}): AsyncIterable<DeploymentEvent> {
  return subscriptionEvents(async write => {
    const buffered: E[] = [];
    let ready = false, overflow = false, bytes = 0;
    const emit = (event: E) => write(event.type, JSON.stringify(options.present ? options.present(event) : event));
    const unsubscribe = options.bus.subscribe(options.id, event => {
      if (ready) emit(event);
      else {
        bytes += JSON.stringify(event).length;
        if (buffered.length < 1024 && bytes <= 16 * 1024 * 1024) buffered.push(event);
        else overflow = true;
      }
    });
    try {
      const row = await options.load();
      options.signal?.throwIfAborted();
      if (overflow) throw new AppError("Event consumer fell behind; reconnect to read current state", 409, "EVENT_BACKPRESSURE");
      emit(options.snapshot(row));
      ready = true;
      const terminal = options.complete(row);
      if (terminal) { emit(terminal); unsubscribe(); }
      else for (const event of buffered) emit(event);
      return { success: true, unsubscribe };
    } catch (error) { unsubscribe(); throw error; }
  }, options.signal, "complete");
}
