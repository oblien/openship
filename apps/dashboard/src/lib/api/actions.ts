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
  list: () => data<"list">(api.get(p.workflows)),
  get: (id: string) => data<"get">(api.get(p.workflow(id))),
  save: (input: CreateActionWorkflow, id?: string) =>
    data<"create">(id ? api.patch(p.workflow(id), input) : api.post(p.workflows, input)),
  disable: (id: string) => api.delete(p.workflow(id)),
  runs: (workflowId?: string) =>
    data<"listRuns">(
      api.get(`${p.runs}${workflowId ? `?workflowId=${encodeURIComponent(workflowId)}` : ""}`),
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
  saveRunner: (input: Input<"addRunner">[0], id?: string) =>
    data<"addRunner">(id ? api.patch(p.runner(id), input) : api.post(p.runners, input)),
  disableRunner: (id: string) => api.delete(p.runner(id)),
  probeRunner: (id: string) => data<"probeRunner">(api.post(`${p.runner(id)}/probe`)),
  events: (id: string, after = 0) => data<"jobEvents">(api.get(`${p.events(id)}?after=${after}`)),
  preview: (source: string, path?: string) =>
    data<"preview">(api.post(p.preview, { source, path })),
  discover: (owner: string, repo: string, ref: string) =>
    data<"discover">(api.get(`${p.discover}?${new URLSearchParams({ owner, repo, ref })}`)),
};
