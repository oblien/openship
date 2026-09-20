/**
 * A cloud call that failed with a status the CALLER has to act on.
 *
 * The SaaS already forwards Openship Cloud's machine-readable `code` alongside its
 * status (`oblienErrorResponse` → `c.json({ error, code })`), but the throwing
 * client methods used to flatten both into one message string. That made
 * `403 target_unverified` — the single code the whole verification flow branches on
 * — reachable only by substring-matching a human sentence.
 *
 * Deliberately an Error subclass rather than a result shape: every existing caller
 * catches and reads `.message`, and those keep working untouched. Converting them
 * to result-semantics would ripple through `syncManagedEdgeRoutes`' per-domain
 * best-effort loop for no gain.
 */
export class CloudRequestError extends Error {
  readonly status: number;
  /** Machine-readable code from the upstream, when it sent one. Never invented. */
  readonly code?: string;

  constructor(message: string, opts: { status: number; code?: string }) {
    super(message);
    this.name = "CloudRequestError";
    this.status = opts.status;
    if (opts.code) this.code = opts.code;
  }
}

export const TARGET_UNVERIFIED_CODE = "target_unverified";

/** Did this failure mean "the target isn't proven yet"? The one code the
 *  verify-and-retry flow keys on, asked in exactly one place. */
export function isTargetUnverified(err: unknown): boolean {
  return err instanceof CloudRequestError && err.code === TARGET_UNVERIFIED_CODE;
}

/**
 * Build a `CloudRequestError` from a non-OK SaaS response.
 *
 * Reads the body ONCE and tolerates non-JSON: an HTML error page from a proxy in
 * front of the SaaS is a realistic 502, and it must still produce a usable status
 * rather than throwing inside the error path.
 */
export async function cloudRequestError(
  res: Response,
  label: string,
): Promise<CloudRequestError> {
  const text = await res.text().catch(() => "");
  let error: string | undefined;
  let code: string | undefined;
  try {
    const body = JSON.parse(text) as { error?: unknown; code?: unknown };
    if (typeof body.error === "string") error = body.error;
    if (typeof body.code === "string") code = body.code;
  } catch {
    // Not JSON — the raw text is the best message available.
  }
  return new CloudRequestError(error ?? `${label} failed (${res.status}): ${text}`, {
    status: res.status,
    ...(code ? { code } : {}),
  });
}
