/**
 * Bounded-concurrency map.
 *
 * Extracted from the container health watch, which needed it because probing a
 * host is not free: `docker inspect` is ~2ms but `docker stats` occupies the daemon
 * for roughly a SECOND (it has to collect two CPU samples to compute a delta). An
 * unbounded `Promise.all` over a 40-container box therefore doesn't just run hot —
 * it fires 40 concurrent requests at one daemon and can push a polling tick past
 * its own interval.
 *
 * Shared so the health watch and the resource sampler use the same limiter rather
 * than each growing a private copy that drifts.
 *
 * Pull-based on a shared cursor rather than chunked: chunking makes every batch wait
 * for its slowest member, which matters here because container stats latency varies
 * widely (a busy container's daemon call is slower than an idle one's).
 */
export async function mapWithLimit<T, R = void>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      // Bounded by LENGTH, not by `items[index] === undefined`. The element test stopped a
      // worker dead on any array holding an `undefined` (or a hole), silently skipping
      // every item after it — and it is what made a results-returning variant impossible,
      // which is why two private copies grew in the migration module instead.
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T);
    }
  });
  await Promise.all(workers);
  // ORDERED by input index, so a caller can zip the results back onto its items.
  return results;
}
