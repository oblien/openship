/**
 * Service-connection controller — wire a database app into a project.
 * Routes are project-scoped (`:id` = the consumer/target project).
 */

import type { Context } from "hono";
import { getRequestContext } from "../../lib/request-context";
import { param } from "../../lib/controller-helpers";
import {
  listConnections,
  createConnection,
  deleteConnection,
  type ConnectionMode,
} from "./project-connection.service";

/** GET /api/projects/:id/connections — links this consumer project depends on. */
export async function list(c: Context) {
  const ctx = getRequestContext(c);
  return c.json({ data: await listConnections(ctx, param(c, "id")) });
}

/** POST /api/projects/:id/connections — link a source DB app into this project. */
export async function create(c: Context) {
  const ctx = getRequestContext(c);
  type Body = {
    sourceProjectId?: string;
    outputId?: string;
    envKey?: string;
    mode?: ConnectionMode;
  };
  const body = await c.req.json<Body>().catch((): Body => ({}));
  if (!body.sourceProjectId || !body.outputId || !body.envKey) {
    return c.json({ error: "sourceProjectId, outputId and envKey are required" }, 400);
  }
  try {
    const result = await createConnection(ctx, param(c, "id"), {
      sourceProjectId: body.sourceProjectId,
      outputId: body.outputId,
      envKey: body.envKey,
      // mode is normalized in the service (single authority) — pass it raw.
      mode: body.mode,
    });
    return c.json({ data: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create connection";
    return c.json({ error: message }, 400);
  }
}

/** DELETE /api/projects/:id/connections/:linkId — remove a link + its env var. */
export async function remove(c: Context) {
  const ctx = getRequestContext(c);
  return c.json({ data: await deleteConnection(ctx, param(c, "id"), param(c, "linkId")) });
}
