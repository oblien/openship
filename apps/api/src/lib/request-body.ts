import type { Context } from "hono";

/**
 * Only a zero-byte body means omitted options; malformed JSON must still fail.
 * Operations validate decoded input. Required bodies use c.req.json() instead.
 */
export async function readOptionalJsonBody<T = unknown>(c: Context): Promise<T> {
  const body = await c.req.text();
  return JSON.parse(body.length ? body : "{}");
}
