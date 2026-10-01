/** Tail of the in-flight chain per scopeKey. Each tail always resolves. */
const tails = new Map<string, Promise<unknown>>();

/**
 * Run `fn` after every earlier call for the same `scopeKey` has finished — an
 * in-process mutex keyed by scope. Different scopeKeys never block each other.
 */
export function withKeyedMutex<T>(
  scopeKey: string,
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const prev = tails.get(scopeKey) ?? Promise.resolve();
  // prev always resolves (tails never reject), so fn runs after prev settles.
  let started = false;
  const result = prev.then(() => {
    started = true;
    if (signal?.aborted) throw new Error("Operation cancelled while waiting for lock");
    return fn();
  });
  // The chain tail swallows errors so a throwing fn never blocks later callers.
  const tail = result.then(
    () => {},
    () => {},
  );
  tails.set(scopeKey, tail);
  // Drop the entry once idle so the map doesn't grow unbounded.
  void tail.then(() => {
    if (tails.get(scopeKey) === tail) tails.delete(scopeKey);
  });
  if (!signal) return result;

  // A waiter may leave immediately when cancelled, but a critical section that
  // already started must be allowed to settle. Returning early from a running
  // section would let a replacement deploy race its Docker/edge mutations. The
  // queued tail still performs the same abort check, so it becomes a no-op when
  // the cancelled waiter eventually reaches the head.
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (started || settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(new Error("Operation cancelled while waiting for lock"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    result.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
  });
}
