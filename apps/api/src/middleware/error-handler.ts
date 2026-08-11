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
    return c.json(
      { error: message, code },
      statusCode as 400 | 401 | 403 | 404 | 409 | 500,
    );
  }

  // `c.req.json()` / `JSON.parse` throw a native SyntaxError on a malformed
  // request body. Routes without a `tbValidator("json", …)` (most mutation
  // routes) would otherwise fall through to the 500 branch below, mislabeling
  // a client input error as a server fault. Map it to 400 centrally.
  if (err instanceof SyntaxError) {
    return c.json({ error: "Invalid JSON body", code: "INVALID_JSON" }, 400);
  }

  console.error("[UNHANDLED ERROR]", err);
  return c.json({ error: "Internal server error" }, 500);
}
