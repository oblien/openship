import { trackBackgroundWork } from "./background-work";

/** Bound the caller's advisory wait while keeping the actual probe owned by shutdown. */
export async function advisoryWork<T>(work: Promise<T>, fallback: T, budgetMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      trackBackgroundWork(work),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), budgetMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
