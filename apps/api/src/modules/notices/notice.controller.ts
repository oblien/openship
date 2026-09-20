/** Authentication remains at the HTTP boundary; notices use shared application operations. */
import type { Context } from "hono";
import { publicNoticeOperations, operatorNoticeOperations } from "@repo/platform/engine/modules/notices/notice.operations";
import { param } from "../../lib/controller-helpers";

export async function list(c: Context) { return c.json(await publicNoticeOperations.list()); }
export async function listAll(c: Context) { return c.json({ notices: await operatorNoticeOperations.listAll() }); }
export async function create(c: Context) {
  const body = await c.req.json().catch(() => null);
  return c.json({ notice: await operatorNoticeOperations.create(body) }, 201);
}
export async function remove(c: Context) { return c.json(await operatorNoticeOperations.remove(param(c, "id"))); }
