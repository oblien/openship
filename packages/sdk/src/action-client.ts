import {
  ActionCollectionSchemas,
  ActionResourceSchemas,
  type ActionOperations,
} from "@repo/contracts";
import type { HttpClient } from "./http";
import { createRemoteResourceOperations, createRemoteScopedOperations } from "./resource-client";

export function createRemoteActionOperations(http: HttpClient): ActionOperations {
  const workflow = (id: string) => `/actions/workflows/${encodeURIComponent(id)}`;
  const run = (id: string) => `/actions/runs/${encodeURIComponent(id)}`;
  const runner = (id: string) => `/actions/runners/${encodeURIComponent(id)}`;
  return Object.freeze({
    ...createRemoteScopedOperations(http, ActionCollectionSchemas, {
      list: { method: "GET", path: () => "/actions/workflows", envelope: "data" },
      create: { method: "POST", path: () => "/actions/workflows", envelope: "data" },
      importWorkflows: {
        method: "POST",
        path: () => "/actions/workflows/import",
        envelope: "data",
      },
      listRuns: { method: "GET", path: () => "/actions/runs", envelope: "data" },
      runners: { method: "GET", path: () => "/actions/runners", envelope: "data" },
      enableEmulation: {
        method: "POST",
        path: () => "/actions/runners/emulation",
        envelope: "data",
      },
      addRunner: { method: "POST", path: () => "/actions/runners", envelope: "data" },
      inspectDestination: {
        method: "POST",
        path: () => "/actions/runners/inspect",
        envelope: "data",
      },
      preview: { method: "POST", path: () => "/actions/preview", envelope: "data" },
      discover: { method: "GET", path: () => "/actions/discover", envelope: "data" },
      repositorySource: {
        method: "GET",
        path: () => "/actions/repository-source",
        envelope: "data",
      },
      updateRepositorySource: {
        method: "PUT",
        path: () => "/actions/repository-source",
        envelope: "data",
      },
      projects: { method: "GET", path: () => "/actions/projects", envelope: "data" },
      projectPolicy: { method: "GET", path: () => "/actions/project", envelope: "data" },
      updateDeploymentRequest: {
        method: "POST",
        path: () => "/actions/project/requests",
        envelope: "data",
      },
      updateProjectPolicy: { method: "PUT", path: () => "/actions/project", envelope: "data" },
    }),
    ...createRemoteResourceOperations(http, ActionResourceSchemas, {
      get: { method: "GET", path: workflow, envelope: "data" },
      update: { method: "PATCH", path: workflow, envelope: "data" },
      remove: { method: "DELETE", path: workflow },
      dispatch: { method: "POST", path: (id) => workflow(id) + "/dispatch", envelope: "data" },
      getRun: { method: "GET", path: run, envelope: "data" },
      artifacts: { method: "GET", path: (id) => run(id) + "/artifacts", envelope: "data" },
      artifactDownload: {
        method: "POST",
        path: (id) => run(id) + "/artifacts/download",
        envelope: "data",
      },
      cancel: { method: "POST", path: (id) => run(id) + "/cancel", envelope: "data" },
      approve: { method: "POST", path: (id) => run(id) + "/approve", envelope: "data" },
      rerun: { method: "POST", path: (id) => run(id) + "/rerun", envelope: "data" },
      updateRunner: { method: "PATCH", path: runner, envelope: "data" },
      removeRunner: { method: "DELETE", path: runner },
      probeRunner: { method: "POST", path: (id) => runner(id) + "/probe", envelope: "data" },
      jobEvents: {
        method: "GET",
        path: (id) => `/actions/jobs/${encodeURIComponent(id)}/events`,
        envelope: "data",
      },
    }),
  });
}
