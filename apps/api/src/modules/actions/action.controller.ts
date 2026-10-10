import type { Context } from "hono";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { param } from "../../lib/controller-helpers";
import { operationContext, operationData } from "../../lib/operation-context";
const actions = () => getPlatformKernel().actions;
export async function list(c: Context) {
  return c.json({
    data: await operationData(
      c,
      actions().list(operationContext(c), { projectId: c.req.query("projectId") }),
    ),
  });
}
export async function create(c: Context) {
  return c.json({
    data: await operationData(c, actions().create(operationContext(c), await c.req.json())),
  });
}
export async function listRuns(c: Context) {
  return c.json({
    data: await operationData(
      c,
      actions().listRuns(operationContext(c), {
        workflowId: c.req.query("workflowId"),
        projectId: c.req.query("projectId"),
        limit: c.req.query("limit") === undefined ? undefined : Number(c.req.query("limit")),
      }),
    ),
  });
}
export async function runners(c: Context) {
  return c.json({ data: await operationData(c, actions().runners(operationContext(c))) });
}
export async function addRunner(c: Context) {
  return c.json({
    data: await operationData(c, actions().addRunner(operationContext(c), await c.req.json())),
  });
}
export async function inspectDestination(c: Context) {
  return c.json({
    data: await operationData(
      c,
      actions().inspectDestination(operationContext(c), await c.req.json()),
    ),
  });
}
export async function preview(c: Context) {
  return c.json({
    data: await operationData(c, actions().preview(operationContext(c), await c.req.json())),
  });
}
export async function discover(c: Context) {
  return c.json({
    data: await operationData(
      c,
      actions().discover(operationContext(c), {
        owner: c.req.query("owner") ?? "",
        repo: c.req.query("repo") ?? "",
        ref: c.req.query("ref") ?? "",
      }),
    ),
  });
}
export async function get(c: Context) {
  return c.json({
    data: await operationData(c, actions().get(operationContext(c), param(c, "id"))),
  });
}
export async function repositorySource(c: Context) {
  return c.json({
    data: await operationData(
      c,
      actions().repositorySource(operationContext(c), {
        owner: c.req.query("owner") ?? "",
        repo: c.req.query("repo") ?? "",
        ref: c.req.query("ref") ?? "",
        path: c.req.query("path") ?? "",
      }),
    ),
  });
}
export async function updateRepositorySource(c: Context) {
  return c.json({
    data: await operationData(
      c,
      actions().updateRepositorySource(operationContext(c), await c.req.json()),
    ),
  });
}
export async function projects(c: Context) {
  return c.json({ data: await operationData(c, actions().projects(operationContext(c))) });
}
export async function projectPolicy(c: Context) {
  return c.json({
    data: await operationData(
      c,
      actions().projectPolicy(operationContext(c), { projectId: c.req.query("projectId") ?? "" }),
    ),
  });
}
export async function updateProjectPolicy(c: Context) {
  return c.json({
    data: await operationData(
      c,
      actions().updateProjectPolicy(operationContext(c), await c.req.json()),
    ),
  });
}
export async function update(c: Context) {
  return c.json({
    data: await operationData(
      c,
      actions().update(operationContext(c), param(c, "id"), await c.req.json()),
    ),
  });
}
export async function remove(c: Context) {
  return c.json(await operationData(c, actions().remove(operationContext(c), param(c, "id"))));
}
export async function dispatch(c: Context) {
  return c.json({
    data: await operationData(
      c,
      actions().dispatch(operationContext(c), param(c, "id"), await c.req.json()),
    ),
  });
}
export async function getRun(c: Context) {
  return c.json({
    data: await operationData(c, actions().getRun(operationContext(c), param(c, "id"))),
  });
}
export async function artifacts(c: Context) {
  return c.json({
    data: await operationData(c, actions().artifacts(operationContext(c), param(c, "id"))),
  });
}
export async function artifactDownload(c: Context) {
  return c.json({
    data: await operationData(
      c,
      actions().artifactDownload(operationContext(c), param(c, "id"), await c.req.json()),
    ),
  });
}
export async function cancel(c: Context) {
  return c.json({
    data: await operationData(c, actions().cancel(operationContext(c), param(c, "id"))),
  });
}
export async function approve(c: Context) {
  return c.json({
    data: await operationData(c, actions().approve(operationContext(c), param(c, "id"))),
  });
}
export async function rerun(c: Context) {
  return c.json({
    data: await operationData(
      c,
      actions().rerun(operationContext(c), param(c, "id"), await c.req.json()),
    ),
  });
}
export async function updateRunner(c: Context) {
  return c.json({
    data: await operationData(
      c,
      actions().updateRunner(operationContext(c), param(c, "id"), await c.req.json()),
    ),
  });
}
export async function removeRunner(c: Context) {
  return c.json(
    await operationData(c, actions().removeRunner(operationContext(c), param(c, "id"))),
  );
}
export async function probeRunner(c: Context) {
  return c.json({
    data: await operationData(c, actions().probeRunner(operationContext(c), param(c, "id"))),
  });
}
export async function jobEvents(c: Context) {
  return c.json({
    data: await operationData(
      c,
      actions().jobEvents(operationContext(c), param(c, "id"), {
        after: c.req.query("after") === undefined ? undefined : Number(c.req.query("after")),
      }),
    ),
  });
}

export async function updateDeploymentRequest(c: Context) {
  return c.json({
    data: await operationData(
      c,
      actions().updateDeploymentRequest(operationContext(c), await c.req.json()),
    ),
  });
}

export async function enableEmulation(c: Context) {
  return c.json({
    data: await operationData(
      c,
      actions().enableEmulation(operationContext(c), await c.req.json()),
    ),
  });
}
