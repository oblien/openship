import { EventEmitter } from "node:events";

export interface RunBus<E> {
  /** Emit to every subscriber; close the channel after a terminal event. */
  publish(id: string, event: E): void;
  /** Attach a listener; returns an unsubscribe fn. */
  subscribe(id: string, listener: (event: E) => void): () => void;
}

/**
 * A per-id event topic. `isFinal` decides when the channel closes — after a
 * terminal event, listeners are removed on the next tick (so pending writes
 * flush first). `maxListeners` allows for multiple dashboard tabs on one run.
 */
export function createRunBus<E>(
  isFinal: (event: E) => boolean,
  maxListeners = 32,
): RunBus<E> {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(maxListeners);
  return {
    publish(id, event) {
      emitter.emit(id, event);
      if (isFinal(event)) {
        setImmediate(() => emitter.removeAllListeners(id));
      }
    },
    subscribe(id, listener) {
      const wrapped = (event: E) => listener(event);
      emitter.on(id, wrapped);
      return () => emitter.off(id, wrapped);
    },
  };
}
