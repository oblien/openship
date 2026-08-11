/**
 * A yes-with-a-value or a no-with-a-reason — and deliberately nothing else.
 *
 * Every "can Openship do X on this host" answer in the provisioning path used to have a
 * third shape: `undefined`, an empty array, a miss on a `Record<string, T>` lookup. That
 * third shape is what a call site reads as "nothing to do here", which is how a host
 * outside a hardcoded allowlist came to finish provisioning with no dockerd and no error
 * anywhere. Two arms means a refusal has to carry a reason, and the reason has to be
 * written by whoever knew why.
 */
export type Answer<T> =
  | { readonly supported: true; readonly value: T }
  | { readonly supported: false; readonly reason: string };

export function answered<T>(value: T): Answer<T> {
  return { supported: true, value };
}

/** `Answer<never>`, so one refusal is assignable to an `Answer<T>` for every T. */
export function refused(reason: string): Answer<never> {
  return { supported: false, reason };
}

/**
 * There is deliberately no `orThrow(answer, context)` here.
 *
 * One was written for the call sites that "cannot continue", and it turned out there are
 * none: `releaseArch` is the case it was meant for, and its consumer
 * (`toolchain/catalog.ts`) propagates the refusal as its own return value instead, which
 * keeps the reason attributable to the tool being installed. The other candidate,
 * `openship-server-store.ts`, throws `grant.reason` bare on purpose — `privilegedExecutor`
 * already renders the caller's `purpose` into that reason, so prefixing a context would
 * print it twice.
 *
 * If you need one, note that both arms above are self-describing: a refusal already says
 * which host it is about and why, so `throw new Error(answer.reason)` needs no wrapper.
 */
