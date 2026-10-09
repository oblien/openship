import { Hono } from "hono";
import { ActionCollectionSchemas as C, ActionResourceSchemas as R } from "@repo/contracts";
import { secureRouter } from "../../lib/secure-router";
import * as ctrl from "./action.controller";
const r = secureRouter(new Hono(), { module: "actions", basePath: "/api/actions" });
r.get(
  "/workflows",
  {
    authorizationHandledByOperation: true,
    tag: "job:read",
    query: C.list.input,
    mcp: { description: "List authorized GitHub-compatible Openship Actions workflows." },
  },
  ctrl.list,
);
r.post(
  "/workflows",
  {
    authorizationHandledByOperation: true,
    tag: "job:write",
    auditHandledByOperation: true,
    body: C.create.input,
    mcp: {
      description:
        "Configure an Actions workflow and its authorized runner destinations. Secrets are encrypted and never returned.",
    },
  },
  ctrl.create,
);
r.get(
  "/runs",
  {
    authorizationHandledByOperation: true,
    tag: "job:read",
    query: C.listRuns.input,
    mcp: { description: "List durable workflow runs and their job states." },
  },
  ctrl.listRuns,
);
r.get(
  "/runners",
  {
    authorizationHandledByOperation: true,
    tag: "job:read",
    mcp: {
      description:
        "List Actions runners and their verified OS, architecture and Docker capabilities.",
    },
  },
  ctrl.runners,
);
r.post(
  "/runners",
  {
    authorizationHandledByOperation: true,
    tag: "job:admin",
    auditHandledByOperation: true,
    body: C.addRunner.input,
    mcp: {
      description:
        "Enable Actions on an authorized server. Native runners execute trusted workflow code as the server's connected user.",
    },
  },
  ctrl.addRunner,
);
r.post(
  "/runners/inspect",
  {
    authorizationHandledByOperation: true,
    tag: "job:admin",
    readOnly: true,
    body: C.inspectDestination.input,
    mcp: {
      description:
        "Check OS, architecture, Git and Docker on an authorized Actions destination without changing the server.",
    },
  },
  ctrl.inspectDestination,
);
r.post(
  "/preview",
  {
    authorizationHandledByOperation: true,
    tag: "job:read",
    readOnly: true,
    body: C.preview.input,
    mcp: {
      description: "Validate workflow YAML and preview its dependency graph without executing it.",
    },
  },
  ctrl.preview,
);
r.get(
  "/discover",
  {
    authorizationHandledByOperation: true,
    tag: "job:read",
    query: C.discover.input,
    mcp: { description: "Discover workflow files in a repository." },
  },
  ctrl.discover,
);
r.get(
  "/workflows/:id",
  {
    authorizationHandledByOperation: true,
    tag: "job:read",
    mcp: { description: "Read a configured workflow without secret values." },
  },
  ctrl.get,
);
r.patch(
  "/workflows/:id",
  {
    authorizationHandledByOperation: true,
    tag: "job:write",
    auditHandledByOperation: true,
    body: R.update.input,
    mcp: { description: "Update an Actions workflow's configuration." },
  },
  ctrl.update,
);
r.delete(
  "/workflows/:id",
  {
    authorizationHandledByOperation: true,
    tag: "job:write",
    auditHandledByOperation: true,
    mcp: { description: "Disable a workflow while retaining its execution history." },
  },
  ctrl.remove,
);
r.post(
  "/workflows/:id/dispatch",
  {
    authorizationHandledByOperation: true,
    tag: "job:write",
    auditHandledByOperation: true,
    body: R.dispatch.input,
    mcp: {
      description: "Dispatch a workflow using an idempotency key and an immutable resolved commit.",
    },
  },
  ctrl.dispatch,
);
r.get(
  "/runs/:id",
  {
    authorizationHandledByOperation: true,
    tag: "job:read",
    mcp: { description: "Read workflow topology, jobs, outputs and completion." },
  },
  ctrl.getRun,
);
r.get(
  "/runs/:id/artifacts",
  {
    authorizationHandledByOperation: true,
    tag: "job:read",
    mcp: { description: "List the artifacts retained for an authorized workflow run." },
  },
  ctrl.artifacts,
);
r.post(
  "/runs/:id/artifacts/download",
  {
    authorizationHandledByOperation: true,
    tag: "job:read",
    readOnly: true,
    body: R.artifactDownload.input,
    mcp: { description: "Get a short-lived download link for one authorized artifact." },
  },
  ctrl.artifactDownload,
);
r.post(
  "/runs/:id/cancel",
  {
    authorizationHandledByOperation: true,
    tag: "job:write",
    auditHandledByOperation: true,
    mcp: {
      description:
        "Request cancellation. Runner capacity is released only after execution has stopped.",
    },
  },
  ctrl.cancel,
);
r.post(
  "/runs/:id/approve",
  {
    authorizationHandledByOperation: true,
    tag: "job:admin",
    auditHandledByOperation: true,
    mcp: {
      description:
        "Approve an untrusted fork run for disposable runners without secrets or write tokens.",
    },
  },
  ctrl.approve,
);
r.post(
  "/runs/:id/rerun",
  {
    authorizationHandledByOperation: true,
    tag: "job:write",
    auditHandledByOperation: true,
    body: R.rerun.input,
    mcp: { description: "Retry the same immutable workflow and commit as a new attempt." },
  },
  ctrl.rerun,
);
r.patch(
  "/runners/:id",
  {
    authorizationHandledByOperation: true,
    tag: "job:admin",
    auditHandledByOperation: true,
    body: R.updateRunner.input,
    mcp: { description: "Update an idle runner's configuration." },
  },
  ctrl.updateRunner,
);
r.delete(
  "/runners/:id",
  {
    authorizationHandledByOperation: true,
    tag: "job:admin",
    auditHandledByOperation: true,
    mcp: { description: "Disable a runner for new jobs, retaining active jobs and history." },
  },
  ctrl.removeRunner,
);
r.post(
  "/runners/:id/probe",
  {
    authorizationHandledByOperation: true,
    tag: "job:admin",
    mcp: { description: "Recheck an authorized runner's capabilities." },
  },
  ctrl.probeRunner,
);
r.get(
  "/jobs/:id/events",
  {
    authorizationHandledByOperation: true,
    tag: "job:read",
    query: R.jobEvents.input,
    mcp: {
      description:
        "Read masked job logs after a durable cursor. Resume with next after reconnecting.",
    },
  },
  ctrl.jobEvents,
);
r.get("/repository-source", {
    authorizationHandledByOperation: true,
    tag: "job:read",
    query: C.repositorySource.input,
    mcp: { description: "Read a repository workflow and preview its topology." },
  }, ctrl.repositorySource);

r.put("/repository-source", {
    authorizationHandledByOperation: true,
    tag: "job:write",
    body: C.updateRepositorySource.input,
    auditHandledByOperation: true,
    mcp: { description: "Commit reviewed workflow YAML to its branch using the expected file SHA." },
  }, ctrl.updateRepositorySource);

r.get("/projects", {
    authorizationHandledByOperation: true,
    tag: "job:read",
    mcp: { description: "List projects available for linking to workflows." },
  }, ctrl.projects);

r.get("/project", {
    authorizationHandledByOperation: true,
    tag: "job:read",
    query: C.projectPolicy.input,
    mcp: { description: "Read project workflows and deployment automation." },
  }, ctrl.projectPolicy);

r.put("/project", {
    authorizationHandledByOperation: true,
    tag: "job:write",
    body: C.updateProjectPolicy.input,
    auditHandledByOperation: true,
    mcp: { description: "Configure required workflow checks before automatic project deployment." },
  }, ctrl.updateProjectPolicy);

r.post("/project/requests", {
  authorizationHandledByOperation: true, tag: "job:write",
  body: C.updateDeploymentRequest.input, auditHandledByOperation: true,
  mcp: { description: "Retry or cancel a project's pending Actions deployment approval." },
}, ctrl.updateDeploymentRequest);

export const actionRoutes = r.hono;
