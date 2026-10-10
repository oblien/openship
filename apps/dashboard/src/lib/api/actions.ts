import type { ActionOperations, CreateActionWorkflow } from "@repo/contracts";
import { api } from "./client";
import { endpoints } from "./endpoints";

const p = endpoints.actions;
type Result<K extends keyof ActionOperations> = Awaited<ReturnType<ActionOperations[K]>>;
type Input<K extends keyof ActionOperations> = Parameters<ActionOperations[K]>;
const data = <K extends keyof ActionOperations>(response: Promise<{ data: Result<K> }>) =>
  response.then((value) => value.data);

/** HTTP transport only; authorization, validation and scheduling live in the platform. */
export const actionsApi = {
  list: (projectId?: string) =>
    data<"list">(
      api.get(`${p.workflows}${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`),
    ),
  get: (id: string) => data<"get">(api.get(p.workflow(id))),
  save: (input: CreateActionWorkflow, id?: string) =>
    data<"create">(id ? api.patch(p.workflow(id), input) : api.post(p.workflows, input)),
  disable: (id: string) => api.delete(p.workflow(id)),
  runs: (workflowId?: string, projectId?: string) =>
    data<"listRuns">(
      api.get(
        `${p.runs}?${new URLSearchParams({ ...(workflowId && { workflowId }), ...(projectId && { projectId }) })}`,
      ),
    ),
  run: (id: string) => data<"getRun">(api.get(p.run(id))),
  artifacts: (id: string) => data<"artifacts">(api.get(`${p.run(id)}/artifacts`)),
  artifactDownload: (id: string, artifactId: number) =>
    data<"artifactDownload">(api.post(`${p.run(id)}/artifacts/download`, { artifactId })),
  dispatch: (id: string, input: Input<"dispatch">[1]) =>
    data<"dispatch">(api.post(`${p.workflow(id)}/dispatch`, input)),
  cancel: (id: string) => data<"cancel">(api.post(`${p.run(id)}/cancel`)),
  approve: (id: string) => data<"approve">(api.post(`${p.run(id)}/approve`)),
  rerun: (id: string, key: string) =>
    data<"rerun">(api.post(`${p.run(id)}/rerun`, { idempotencyKey: key })),
  runners: () => data<"runners">(api.get(p.runners)),
  inspectDestination: (serverId: string) =>
    data<"inspectDestination">(api.post(`${p.runners}/inspect`, { serverId })),
  enableEmulation: (serverId: string) =>
    data<"enableEmulation">(api.post(`${p.runners}/emulation`, { serverId })),
  saveRunner: (input: Input<"addRunner">[0], id?: string) =>
    data<"addRunner">(id ? api.patch(p.runner(id), input) : api.post(p.runners, input)),
  disableRunner: (id: string) => api.delete(p.runner(id)),
  probeRunner: (id: string) => data<"probeRunner">(api.post(`${p.runner(id)}/probe`)),
  events: (id: string, after = 0) => data<"jobEvents">(api.get(`${p.events(id)}?after=${after}`)),
  preview: (source: string, path?: string) =>
    data<"preview">(api.post(p.preview, { source, path })),
  projects: () => data<"projects">(api.get("actions/projects")),
  projectPolicy: (projectId: string) =>
    data<"projectPolicy">(api.get(`actions/project?${new URLSearchParams({ projectId })}`)),
  updateProjectPolicy: (input: Input<"updateProjectPolicy">[0]) =>
    data<"updateProjectPolicy">(api.put("actions/project", input)),
  updateDeploymentRequest: (input: Input<"updateDeploymentRequest">[0]) =>
    data<"updateDeploymentRequest">(api.post("actions/project/requests", input)),
  repositorySource: (input: Input<"repositorySource">[0]) =>
    data<"repositorySource">(api.get(`actions/repository-source?${new URLSearchParams(input)}`)),
  updateRepositorySource: (input: Input<"updateRepositorySource">[0]) =>
    data<"updateRepositorySource">(api.put("actions/repository-source", input)),
  discover: (owner: string, repo: string, ref: string) =>
    data<"discover">(api.get(`${p.discover}?${new URLSearchParams({ owner, repo, ref })}`)),
};
