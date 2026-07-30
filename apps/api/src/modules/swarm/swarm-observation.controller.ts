import type { Context } from "hono";
import { getRequestContext } from "../../lib/request-context";
import { swarmObservation } from "./swarm-observation.service";

export async function status(c: Context) {
  const ctx = getRequestContext(c);
  return c.json(await swarmObservation.status(c.req.param("id")!, ctx.organizationId));
}

export async function refresh(c: Context) {
  const ctx = getRequestContext(c);
  return c.json(await swarmObservation.refresh(c.req.param("id")!, ctx.organizationId));
}
