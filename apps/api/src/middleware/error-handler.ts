import type { Context } from "hono";
import { ZodError } from "zod";
import { AppError } from "@repo/core";

/**
 * Translate a thrown error to a structured JSON response.
 *
 * Order of precedence:
 * 1. ZodError → 400 with field-level details
 * 2. AppError subclass → statusCode + message + code
 * 3. SyntaxError → 400 (malformed JSON request body)
 * 4. Unknown → 500
 *
 * Registered via `app.onError(handleApiError)`. Hono's compose() wraps
 * each dispatch level in try/catch and routes thrown errors to
 * `this.errorHandler` (Hono instance, set via `app.onError`). A throw
 * from a route handler is caught at the route's own dispatch level — it
 * never propagates up to a parent middleware's `await next()`, so a
 * try/catch-around-next middleware would never see downstream throws.
 */
export function handleApiError(err: unknown, c: Context) {
  if (err instanceof ZodError) {
    return c.json(
      {
        error: "Validation error",
        code: "VALIDATION_ERROR",
        details: err.flatten().fieldErrors,
      },
      400,
    );
  }

  if (err instanceof AppError) {
    const { message, code, statusCode } = err;
    /** Extra fields a plan-gate refusal contributes to the JSON body. Kept local
     *  and duck-typed so the error handler doesn't import the billing layer. */
    function planErrorDetail(e: AppError): Record<string, unknown> {
      if (e.code !== "PLAN_UPGRADE_REQUIRED") return {};
      const withDetail = e as AppError & {
        reason?: string;
        planTierId?: string;
        slots?: unknown[];
      };
      return {
        ...(withDetail.reason ? { reason: withDetail.reason } : {}),
        ...(withDetail.planTierId ? { planTierId: withDetail.planTierId } : {}),
        ...(withDetail.slots ? { slots: withDetail.slots } : {}),
      };
    }
    // A 5xx is a SERVER fault and must leave a trace, even when it arrives as a typed
    // AppError carrying its own message. `AppError`'s statusCode defaults to 500, so
    // a bare `new AppError(msg)` used to answer 500 and log NOTHING — the "500 with no
    // actionable information in the logs" of GH-562. 4xx stays quiet on purpose: those
    // are client outcomes, and logging them turns ordinary validation into noise.
    if (statusCode >= 500) console.error(`[API ERROR] ${requestTag(c)}`, err);
    return c.json(
      {
        error: message,
        code,
        // A plan refusal carries structured detail the client needs to be
        // ACTIONABLE: `reason` picks the right upgrade CTA, and a
        // free-subdomain refusal carries the slots already in use so the UI can
        // offer Release next to each hostname. A message string alone leaves the
        // user knowing they're at a limit and not where it went.
        ...planErrorDetail(err),
      },
      // 502/503 included: an AppError can legitimately mean "an upstream we
      // depend on failed" (HostUnreachableError, ManagedEdgeError), and casting
      // those away made this the one place that couldn't express the status the
      // error itself already carried.
      statusCode as 400 | 401 | 403 | 404 | 409 | 500 | 502 | 503,
    );
  }

  // `c.req.json()` / `JSON.parse` throw a native SyntaxError on a malformed
  // request body. Routes without a `tbValidator("json", …)` (most mutation
  // routes) would otherwise fall through to the 500 branch below, mislabeling
  // a client input error as a server fault. Map it to 400 centrally.
  if (err instanceof SyntaxError) {
    return c.json({ error: "Invalid JSON body", code: "INVALID_JSON" }, 400);
  }

  // Log the route with it. `[UNHANDLED ERROR] Error: doveadm pw returned …` on its own
  // doesn't say WHICH request produced it, which is most of the work of diagnosing a
  // 500 from a log file. The response body stays deliberately generic — an unknown
  // error's message can carry internals we don't hand to a client.
  console.error(`[UNHANDLED ERROR] ${requestTag(c)}`, err);
  return c.json({ error: "Internal server error" }, 500);
}

/**
 * `METHOD /path` for a log line. Query string omitted: it can carry tokens.
 *
 * Exported for the handlers that answer a 5xx THEMSELVES (the mail funnels), so every
 * server-fault line in the log reads the same and is greppable by route. The try/catch
 * below is load-bearing for those callers: a handler under test can be driven with a
 * context that has no `method`/`url`, and this must not throw from inside a catch block.
 */
export function requestTag(c: Context): string {
  try {
    return `${c.req.method} ${new URL(c.req.url).pathname}`;
  } catch {
    return c.req.method;
  }
}
