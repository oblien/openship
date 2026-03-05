import type { Context } from "hono";

export async function list(c: Context) {
  // TODO: List all projects for authenticated user
  return c.json({ data: [] });
}

export async function create(c: Context) {
  // TODO: Create new project
  return c.json({ message: "created" }, 201);
}

export async function getById(c: Context) {
  const id = c.req.param("id");
  // TODO: Fetch project by ID
  return c.json({ data: { id } });
}

export async function update(c: Context) {
  const id = c.req.param("id");
  // TODO: Update project
  return c.json({ data: { id } });
}

export async function remove(c: Context) {
  const id = c.req.param("id");
  // TODO: Soft-delete project
  return c.json({ message: "deleted" });
}
