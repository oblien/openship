/**
 * Object-storage controller — bind an S3 bucket to a project's filesystem
 * config. Routes are project-scoped (`:id` = the app that gets the bucket).
 */

import type { Context } from "hono";
import { getRequestContext } from "../../lib/request-context";
import { param } from "../../lib/controller-helpers";
import {
  bindObjectStorage,
  getObjectStorage,
  unbindObjectStorage,
  type BindObjectStorageInput,
} from "./project-storage.service";

/** GET /api/projects/:id/storage — current binding + what can be bound. */
export async function get(c: Context) {
  const ctx = getRequestContext(c);
  return c.json({ data: await getObjectStorage(ctx, param(c, "id")) });
}

/** POST /api/projects/:id/storage — bind a bucket (source app or external S3). */
export async function bind(c: Context) {
  const ctx = getRequestContext(c);
  const body = await c.req.json<BindObjectStorageInput>().catch(() => null);
  if (!body) return c.json({ error: "A JSON body is required" }, 400);
  return c.json({ data: await bindObjectStorage(ctx, param(c, "id"), body) });
}

/** DELETE /api/projects/:id/storage — remove the binding + the env it wrote. */
export async function unbind(c: Context) {
  const ctx = getRequestContext(c);
  return c.json({ data: await unbindObjectStorage(ctx, param(c, "id")) });
}
