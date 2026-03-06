import type { Context, Next } from "hono";
import { ZodError } from "zod";
import { AppError } from "@repo/core";

/**
 * Global error handler middleware.
 * Catches errors thrown anywhere in the request chain and returns
 * a consistent JSON response.
 *
 * Order of precedence:
 * 1. ZodError → 400 with field-level details
 * 2. AppError subclass → statusCode + message + code
 * 3. Unknown → 500
 */
export async function errorHandler(c: Context, next: Next) {
  try {
    await next();
  } catch (err: unknown) {
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

    console.error("[UNHANDLED ERROR]", err);
    return c.json({ error: "Internal server error" }, 500);
  }
}
