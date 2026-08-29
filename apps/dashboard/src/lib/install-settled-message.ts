/**
 * The reason line an install wizard shows under its terminal verdict — or nothing.
 *
 * This is the rule that broke: the wizard decided "was this a cancel?" and "what
 * message do I show?" independently, so a stopped install could set the neutral
 * cancel flag AND take the generic failure string, printing "Install failed" under
 * the heading "Install cancelled".
 *
 * A CANCEL only ever carries a REAL server-side reason. `failureMessage` is empty
 * for a user's Stop, and the stream's cancel frame is a fixed "Build cancelled" —
 * the verdict again, not a reason. Neither may fall through to the failure
 * fallback; with nothing real to say, the view supplies its own cancel copy, which
 * can also state what the cancel cleaned up. A FAILURE keeps the full chain,
 * because there the fallback is the only thing standing between the operator and a
 * blank card.
 *
 * Pure and dependency-free so the invariant is testable without mounting the
 * 1.5k-line wizard page.
 */
export function installSettledMessage(input: {
  /** The row said `cancelled`, or the caller knows this resolution is a cancel. */
  isCancel: boolean;
  /** `failureMessage` off the build-status read — a real reason when non-empty. */
  serverMessage?: string | null;
  /** The SSE terminal frame's message. */
  streamMessage?: string | null;
  /** Localised "Install failed" — the last resort, for failures only. */
  failedFallback: string;
}): string {
  const { isCancel, serverMessage, streamMessage, failedFallback } = input;
  if (isCancel) return serverMessage || "";
  return serverMessage || streamMessage || failedFallback;
}
