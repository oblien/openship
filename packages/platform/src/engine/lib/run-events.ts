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
  /** The bus is local to a process. Durable runs also reconcile while a worker
   * runs elsewhere (or a notification is missed). State events become hints
   * to reload; only transient messages, such as warnings, are forwarded. */
  reconcile?: { everyMs: number; isTransient?(event: E): boolean };
}): AsyncIterable<DeploymentEvent> {
  const failure = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, failure.signal])
    : failure.signal;
  return subscriptionEvents(
    async (write) => {
      const buffered: E[] = [];
      let ready = false,
        overflow = false,
        bytes = 0,
        stopped = false;
      let loading = true,
        invalidated = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let lastSnapshot: string | undefined;
      let unsubscribe = () => {};
      const cleanup = () => {
        if (stopped) return;
        stopped = true;
        clearTimeout(timer);
        unsubscribe();
        signal.removeEventListener("abort", cleanup);
        buffered.length = 0;
      };
      const serialize = (event: E) =>
        JSON.stringify(options.present ? options.present(event) : event);
      const emit = (event: E, data = serialize(event)) => {
        if (stopped) return;
        if (!write(event.type, data)) cleanup();
      };
      const schedule = (delay: number) => {
        clearTimeout(timer);
        if (stopped) return;
        timer = setTimeout(() => {
          timer = undefined;
          void refresh().catch((error) => {
            cleanup();
            failure.abort(error);
          });
        }, delay);
        timer.unref?.();
      };
      const refresh = async () => {
        loading = true;
        invalidated = false;
        try {
          const row = await options.load();
          signal.throwIfAborted();
          if (stopped) return;
          if (overflow)
            throw new AppError(
              "Event consumer fell behind; reconnect to read current state",
              409,
              "EVENT_BACKPRESSURE",
            );
          const snapshot = options.snapshot(row);
          const data = serialize(snapshot);
          if (data !== lastSnapshot) {
            emit(snapshot, data);
            lastSnapshot = data;
          }
          ready = true;
          const terminal = options.complete(row);
          // Durable state is read serially. Never replay older state notifications
          // over a newer snapshot, including notifications received during load.
          if (options.reconcile || !terminal) for (const event of buffered) emit(event);
          buffered.length = 0;
          bytes = 0;
          if (terminal) {
            emit(terminal);
            cleanup();
          }
        } finally {
          loading = false;
        }
        if (options.reconcile && !stopped) schedule(invalidated ? 200 : options.reconcile.everyMs);
      };
      unsubscribe = options.bus.subscribe(options.id, (event) => {
        if (stopped) return;
        if (options.reconcile && !options.reconcile.isTransient?.(event)) {
          // Coalesce a burst of transitions/progress without postponing an
          // already requested refresh or running overlapping database reads.
          if (!invalidated) {
            invalidated = true;
            if (!loading) schedule(200);
          }
        } else if (ready) emit(event);
        else {
          bytes += serialize(event).length;
          if (buffered.length < 1024 && bytes <= 16 * 1024 * 1024) buffered.push(event);
          else overflow = true;
        }
      });
      signal.addEventListener("abort", cleanup, { once: true });
      try {
        await refresh();
        return { success: true, unsubscribe: cleanup };
      } catch (error) {
        cleanup();
        throw error;
      }
    },
    signal,
    "complete",
  );
}
