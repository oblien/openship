import type { Context } from "hono";

export async function github(c: Context) {
  // TODO: Verify GitHub signature, parse push event, trigger deployment
  return c.json({ received: true });
}

export async function gitlab(c: Context) {
  // TODO: Verify GitLab token, parse push event
  return c.json({ received: true });
}

export async function bitbucket(c: Context) {
  // TODO: Verify Bitbucket signature
  return c.json({ received: true });
}

export async function custom(c: Context) {
  const projectId = c.req.param("projectId");
  // TODO: Trigger deployment for project from custom webhook
  return c.json({ received: true, projectId });
}
