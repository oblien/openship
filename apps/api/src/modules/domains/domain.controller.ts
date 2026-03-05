import type { Context } from "hono";

export async function list(c: Context) {
  return c.json({ data: [] });
}

export async function add(c: Context) {
  // TODO: Add custom domain, generate DNS verification record
  return c.json({ message: "domain added" }, 201);
}

export async function remove(c: Context) {
  const id = c.req.param("id");
  return c.json({ message: "domain removed" });
}

export async function verify(c: Context) {
  const id = c.req.param("id");
  // TODO: Check DNS records to verify ownership
  return c.json({ message: "verification started" });
}
