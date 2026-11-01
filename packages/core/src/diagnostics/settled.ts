import { reportCaughtError } from "./reporter";

export function observedAllSettled<T extends readonly unknown[] | []>(
  values: T,
  component: string,
): Promise<{ -readonly [P in keyof T]: PromiseSettledResult<Awaited<T[P]>> }>;
export function observedAllSettled<T>(
  values: Iterable<T | PromiseLike<T>>,
  component: string,
): Promise<PromiseSettledResult<Awaited<T>>[]>;
export async function observedAllSettled(
  values: Iterable<unknown>,
  component: string,
): Promise<PromiseSettledResult<unknown>[]> {
  const results = await Promise.allSettled(values);
  for (const result of results)
    if (result.status === "rejected")
      reportCaughtError(result.reason, component);
  return results;
}
