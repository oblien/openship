import type { Context } from "hono";

/** An empty stream is still an omitted body. Operations validate decoded input. */
export async function readOptionalJsonBody<T = unknown>(c: Context): Promise<T> {
  const body = await c.req.text();
  return JSON.parse(body.length ? body : "{}");
}
