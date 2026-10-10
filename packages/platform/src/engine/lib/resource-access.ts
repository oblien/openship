import { ForbiddenError, NotFoundError, isExternalProject } from "@repo/core";
import { repos } from "@repo/db";
import type { ExecutionContext as RequestContext } from "@repo/platform";

export function assertResourceInOrg<T extends { organizationId?: string | null }>(
  resource: T | null | undefined,
  resourceLabel: string,
  organizationId: string,
  resourceId?: string,
): asserts resource is T {
  if (!resource || resource.organizationId !== organizationId) {
    throw new NotFoundError(resourceLabel, resourceId);
  }
}

/**
 * Refuse a runtime action on the Openship control-plane self-app.
 *
 * The self-app IS the process serving the request, so "stop it" is a request to
 * kill the thing that would report the result. Every mutating surface needs the
 * same answer for the same reason — pausing the PROJECT stops the api container,
 * deleting its `postgres` SERVICE drops the control plane's own database, and its
 * DEPLOYMENT row is an adopt over a CLI-supervised host process, so rolling it
 * back or pinning it would detach the live app. Read paths (status, logs, shell,
 * container info) are deliberately NOT gated: showing the operator that state is
 * the reason the self-app is linked at all.
 *
 * One definition, because it had grown three — a project copy, a services copy,
 * and a deployments wrapper — and they had already drifted: one of them told
 * operators to run `openship restart`, which is not a command (`restart` exists
 * only under `deployment` and `service`).
 */
/**
 * Is this project Openship itself?
 *
 * The boolean behind {@link assertNotControlPlane}, split out because not every
 * caller wants a throw: the migration adopt path needs to RECOGNIZE the control
 * plane's own containers so it can leave them out of a user's project (#584), and
 * refusing there would fail the user's whole migration over a container they never
 * selected. Same one definition either way — `appTemplateId` is stamped by
 * `ensureControlPlaneApp` and is the only durable marker (the NAME is operator-
 * visible text, and the slug differs between the self-app and the deploy project).
 */
export function isControlPlaneProject(
  project: { appTemplateId?: string | null } | null | undefined,
): boolean {
  return project?.appTemplateId === "openship";
}

export function controlPlaneManagementMessage(): string {
  return process.env.OPENSHIP_INSTANCE_PROJECT_ID
    ? "This is your active Openship API. Use Settings → Instance → Move back to Desktop before changing its runtime or updating its service images."
    : "The Openship control plane manages its own runtime — manage it with the CLI on the host (`openship up`, `openship stop`, `openship update`), not from the dashboard.";
}

export function assertNotControlPlane(
  project: { appTemplateId?: string | null } | null | undefined,
): void {
  if (isControlPlaneProject(project)) {
    throw new ForbiddenError(
      controlPlaneManagementMessage(),
    );
  }
}

/**
 * The same policy for callers holding only a project id — a deployment row, a
 * `projectId` route param.
 *
 * Exists so those callers have ONE shape instead of each resolving the project
 * itself: that per-module resolve is what grew into two divergent copies of the
 * check. Callers that already hold the project must use {@link assertNotControlPlane}
 * directly rather than re-fetching it here.
 */
export async function assertNotControlPlaneById(projectId: string): Promise<void> {
  assertNotControlPlane(await repos.project.findById(projectId));
}

export function assertNotExternal(
  project: { gitProvider?: string | null } | null | undefined,
): void {
  if (isExternalProject(project)) {
    throw new ForbiddenError(
      "External projects are deployed by another tool; Openship only reads their logs and status.",
    );
  }
}

export async function assertNotExternalById(projectId: string): Promise<void> {
  assertNotExternal(await repos.project.findById(projectId));
}

/** Both runtime-mutation policies: neither the control plane nor an external project. */
export function assertProjectMutable(
  project: { appTemplateId?: string | null; gitProvider?: string | null } | null | undefined,
): void {
  assertNotControlPlane(project);
  assertNotExternal(project);
}

export async function assertProjectMutableById(projectId: string): Promise<void> {
  assertProjectMutable(await repos.project.findById(projectId));
}

export async function isServerInOrg(
  ctx: RequestContext,
  serverId: string,
): Promise<boolean> {
  const server = await repos.server.getInOrganization(serverId, ctx.organizationId);
  return server != null;
}
