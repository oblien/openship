/**
 * Edge config read-back controller.
 *
 *   GET /api/projects/:id/edge-config
 *
 * Reports, per hostname, what the project SAVED versus what the box is actually
 * serving, so drift (a hand-edited vhost, a value the sanitizer dropped, a
 * directive the box's nginx is too old for) is visible instead of assumed away.
 * Self-hosted only (mounted behind localOnly) and strictly read-only.
 */

import type { Context } from "hono";
import { repos } from "@repo/db";
import { safeErrorMessage } from "@repo/core";

import { getRequestContext } from "../../lib/request-context";
import { param } from "../../lib/controller-helpers";
import { readProjectEdgeConfig } from "./edge-config.service";

export async function getEdgeConfig(c: Context) {
  const organizationId = getRequestContext(c).organizationId;
  const project = await repos.project.findById(param(c, "id"));
  if (!project || project.organizationId !== organizationId) {
    return c.json({ error: "Project not found" }, 404);
  }

  try {
    return c.json(await readProjectEdgeConfig(project));
  } catch (err) {
    // A read that can't reach the box is not an error the UI should surface as a
    // failure — the panel just can't show live values.
    return c.json({
      reachable: false,
      error: safeErrorMessage(err),
      saved: (project.routingConfig?.proxy ?? {}) as Record<string, unknown>,
      hosts: [],
    });
  }
}
