/** Bound independent work and drain started tasks before propagating a failure. */
export async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  run: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(values.length);
  let next = 0;
  let failed = false;
  let failure: unknown;
  const count = Math.min(values.length, Math.max(1, Math.floor(concurrency) || 1));
  await Promise.all(
    Array.from({ length: count }, async () => {
      while (!failed && next < values.length) {
        const index = next++;
        try {
          results[index] = await run(values[index]!, index);
        } catch (error) {
          // diagnostics-ignore: retain the first failure and rethrow it after all admitted commands drain.
          if (!failed) failure = error;
          failed = true;
        }
      }
    }),
  );
  if (failed) throw failure;
  return results;
}

/** Start a task as soon as its own dependencies settle, without a layer barrier.
 * Unknown dependencies remain the caller's policy (e.g. a disabled service).
 * Validate cycles before invoking any task and wait for in-flight work on error. */
export async function runDependencyTasks<T>(
  values: readonly T[],
  options: {
    key: (value: T) => string;
    dependencies: (value: T) => readonly string[];
    concurrency: number;
    /** Release dependents and the activation slot once the resource is usable.
     * Optional: a task without a separate publication phase completes normally. */
    run: (value: T, ready: () => void) => Promise<void>;
  },
): Promise<void> {
  const byKey = new Map(values.map((value) => [options.key(value), value]));
  if (byKey.size !== values.length) throw new Error("Duplicate task identity");
  const visiting = new Set<string>();
  const ordered: string[] = [];
  const visited = new Set<string>();
  const visit = (key: string) => {
    if (visited.has(key)) return;
    if (visiting.has(key)) throw new Error(`Circular service dependency involving ${key}`);
    visiting.add(key);
    for (const dep of options.dependencies(byKey.get(key)!)) if (byKey.has(dep)) visit(dep);
    visiting.delete(key);
    visited.add(key);
    ordered.push(key);
  };
  for (const key of byKey.keys()) visit(key);

  let active = 0;
  const limit = Math.max(1, Math.floor(options.concurrency) || 1);
  const waiting: Array<() => void> = [];
  const tasks = new Map<string, Promise<void>>();
  const readiness = new Map<string, Promise<void>>();
  let failed = false;
  let failure: unknown;
  for (const key of ordered) {
    const value = byKey.get(key)!;
    let resolveReady!: () => void;
    let rejectReady!: (error: unknown) => void;
    const readyPromise = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    readiness.set(key, readyPromise);
    tasks.set(
      key,
      (async () => {
        let ownsSlot = false;
        const release = () => {
          if (!ownsSlot) return;
          ownsSlot = false;
          const resume = waiting.shift();
          if (resume) resume();
          else active--;
        };
        const ready = () => {
          resolveReady();
          release();
        };
        try {
          await Promise.all(options.dependencies(value).map((dep) => readiness.get(dep)));
          if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
          else active++;
          ownsSlot = true;
          if (failed) throw failure;
          await options.run(value, ready);
          ready();
        } catch (error) {
          rejectReady(error);
          if (!failed) failure = error;
          failed = true;
          throw error;
        } finally {
          release();
        }
      })(),
    );
  }
  // Observe leaf readiness failures too; the task remains the owner of error
  // propagation after all publication work has drained.
  await Promise.allSettled([...tasks.values(), ...readiness.values()]);
  if (failed) throw failure;
}
