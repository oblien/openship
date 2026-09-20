/** Tracks owned asynchronous work without changing its result or error behavior. */
export function createTaskGroup() {
  const pending = new Set<Promise<unknown>>();
  return Object.freeze({
    track<T>(work: Promise<T>): Promise<T> {
      pending.add(work);
      void work.then(() => pending.delete(work), () => pending.delete(work));
      return work;
    },
    async drain(): Promise<void> {
      // Finishing a task can enqueue another task; drain that work as well.
      while (pending.size) await Promise.allSettled([...pending]);
    },
  });
}
