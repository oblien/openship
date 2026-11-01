import { SYSTEM } from "@repo/core";
import type { ReleaseCommandOptions } from "./types";

/** One deadline covers preparation, execution and log collection on either runtime. */
export function releaseCommandDeadline(options?: ReleaseCommandOptions) {
  const timeoutMs = options?.timeoutMs ?? SYSTEM.DEPLOYMENTS.RELEASE_COMMAND_TIMEOUT_MS;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(
    new Error(`Release command timed out after ${Math.round(timeoutMs / 1000)}s`),
  ), timeoutMs);
  const signal = options?.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;

  return {
    signal,
    async wait<T>(operation: () => Promise<T>): Promise<T> {
      signal.throwIfAborted();
      return new Promise<T>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        Promise.resolve().then(() => {
          signal.throwIfAborted();
          return operation();
        }).then(
          value => { signal.removeEventListener("abort", abort); resolve(value); },
          error => { signal.removeEventListener("abort", abort); reject(signal.aborted ? signal.reason : error); },
        );
      });
    },
    abort: (reason: unknown) => deadline.abort(reason),
    dispose: () => clearTimeout(timer),
  };
}
