/** Own the upstream iterator even when a caller closes before its first next(). */
export function guardedStream<T>(source: AsyncIterable<T>, options: {
  check?(): Promise<void>;
  /** Interrupt pending reads before waiting for the iterator to settle. */
  cancel?(): void;
  close?(): Promise<void>;
} = {}): AsyncIterableIterator<T> {
  const iterator = source[Symbol.asyncIterator]();
  let closed = false;
  let closing: Promise<void> | undefined;
  const close = () => {
    closed = true;
    return closing ??= Promise.resolve().then(async () => {
      try { options.cancel?.(); await iterator.return?.(); }
      finally { await options.close?.(); }
    });
  };
  return {
    [Symbol.asyncIterator]() { return this; },
    async next() {
      if (closed) return { done: true, value: undefined };
      try {
        await options.check?.();
        if (closed) return { done: true, value: undefined };
        const result = await iterator.next();
        if (closed) return { done: true, value: undefined };
        if (result.done) await close();
        else await options.check?.();
        if (closed) return { done: true, value: undefined };
        return result;
      } catch (error) { await close().catch(() => {}); throw error; }
    },
    async return() { await close(); return { done: true, value: undefined }; },
    async throw(error) { await close(); throw error; },
  };
}
