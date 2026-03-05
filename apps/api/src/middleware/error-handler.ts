import type { Context, Next } from "hono";
import { ZodError } from "zod";

/**
 * Global error handler middleware.
 */
export async function errorHandler(c: Context, next: Next) {
  try {
    await next();
  } catch (err) {
    if (err instanceof ZodError) {
      return c.json(
        { error: "Validation error", details: err.flatten().fieldErrors },
        400,
      );
    }

    console.error("[ERROR]", err);
    return c.json({ error: "Internal server error" }, 500);
  }
}
