/**
 * Project controller — Hono request handlers.
 *
 * Every handler:
 *   1. Extracts user from context (set by authMiddleware)
 *   2. Delegates to project.service
 *   3. Returns consistent JSON
 */

import type { Context } from "hono";
import { getUserId, param } from "../../lib/controller-helpers";
import * as projectService from "./project.service";
import type { TCreateProjectBody, TUpdateProjectBody, TSetEnvVarsBody, TUpdateResourcesBody } from "./project.schema";

// ─── Projects CRUD ───────────────────────────────────────────────────────────

export async function list(c: Context) {
  const userId = getUserId(c);
  const page = Number(c.req.query("page") ?? 1);
  const perPage = Number(c.req.query("perPage") ?? 20);
  const result = await projectService.listProjects(userId, { page, perPage });
  return c.json({
    data: result.rows,
    total: result.total,
    page: result.page,
    perPage: result.perPage,
  });
}

export async function create(c: Context) {
  const userId = getUserId(c);
  const body = await c.req.json<TCreateProjectBody>();
  const project = await projectService.createProject(userId, body);
  return c.json({ data: project }, 201);
}

export async function getById(c: Context) {
  const userId = getUserId(c);
  const id = param(c, "id");
  const project = await projectService.getProject(id, userId);
  return c.json({ data: project });
}

export async function update(c: Context) {
  const userId = getUserId(c);
  const id = param(c, "id");
  const body = await c.req.json<TUpdateProjectBody>();
  const project = await projectService.updateProject(id, userId, body);
  return c.json({ data: project });
}

export async function remove(c: Context) {
  const userId = getUserId(c);
  const id = param(c, "id");
  await projectService.deleteProject(id, userId);
  return c.json({ message: "deleted" });
}

// ─── Environment variables ───────────────────────────────────────────────────

export async function listEnvVars(c: Context) {
  const userId = getUserId(c);
  const id = param(c, "id");
  const environment = c.req.query("environment");
  const vars = await projectService.listEnvVars(id, userId, environment);
  return c.json({ data: vars });
}

export async function setEnvVars(c: Context) {
  const userId = getUserId(c);
  const id = param(c, "id");
  const body = await c.req.json<TSetEnvVarsBody>();
  const result = await projectService.setEnvVars(id, userId, body);
  return c.json(result);
}

// ─── Resources ───────────────────────────────────────────────────────────────

export async function getResources(c: Context) {
  const userId = getUserId(c);
  const id = param(c, "id");
  const resources = await projectService.getResources(id, userId);
  return c.json({ data: resources });
}

export async function updateResources(c: Context) {
  const userId = getUserId(c);
  const id = param(c, "id");
  const body = await c.req.json<TUpdateResourcesBody>();
  const resources = await projectService.updateResources(id, userId, body);
  return c.json({ data: resources });
}
