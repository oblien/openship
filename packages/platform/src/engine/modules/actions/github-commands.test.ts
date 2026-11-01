import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDatabase,
  createRepositories,
  schema,
  type DatabaseConnection,
} from "@repo/db/factory";
import { generateId } from "@repo/core";
import type { ActionRun, ActionWorkflow } from "@repo/db";
import type { ExecutionContext } from "../../../context";
const h = vi.hoisted(() => ({
  repo: null as any,
  dispatch: vi.fn(),
  attempt: vi.fn(),
  run: vi.fn(),
  cancel: vi.fn(),
  rerun: vi.fn(),
  sync: vi.fn(),
}));
vi.mock("@repo/db", () => ({
  repos: {
    get actions() {
      return h.repo;
    },
  },
}));
vi.mock("./github-api", () => ({
  GitHubActionsApi: class {
    dispatch = h.dispatch;
    attempt = h.attempt;
    run = h.run;
    cancel = h.cancel;
    rerun = h.rerun;
  },
}));
vi.mock("./github-sync", () => ({ synchronizeGitHubRun: h.sync }));
import { dispatchGitHubWorkflow, controlGitHubRun, rerunGitHubWorkflow } from "./github-commands";
let connection: DatabaseConnection;
beforeAll(async () => {
  connection = await createDatabase({ driver: "pglite", dataDir: "memory://" });
  h.repo = createRepositories(connection.db, { encrypt: (v) => v, decrypt: (v) => v }).actions;
}, 60000);
afterAll(async () => {
  await connection?.close();
});
beforeEach(() => {
  vi.clearAllMocks();
  h.dispatch.mockResolvedValue({ workflow_run_id: 42 });
  h.attempt.mockResolvedValue({ id: 42 });
  h.sync.mockResolvedValue({ id: "mirrored-run" });
});
async function fixture() {
  const org = generateId("org");
  await connection.db.insert(schema.organization).values({ id: org, name: org });
  const workflow = (await h.repo.saveWorkflow({
    id: generateId("wf"),
    organizationId: org,
    controller: "github",
    githubWorkflowId: "1",
    owner: "owner",
    repo: "test",
    name: "CI",
    path: ".github/workflows/ci.yml",
    ref: "main",
    source: null,
    definition: { name: "CI", triggers: { workflow_dispatch: {} }, jobs: [] },
    runnerIds: [],
    authority: {
      version: 1,
      userId: "owner",
      organizationId: org,
      token: null,
      restrictions: null,
    },
  })) as ActionWorkflow;
  return {
    workflow,
    ctx: { organizationId: org } as ExecutionContext,
    trigger: {
      key: "one-intent",
      eventName: "workflow_dispatch" as const,
      inputs: { version: "1" },
    },
  };
}
describe("GitHub commands and ambiguous responses", () => {
  it("does not replay a dispatch whose response was lost", async () => {
    const f = await fixture();
    h.dispatch.mockRejectedValueOnce(new TypeError("connection lost"));
    await expect(dispatchGitHubWorkflow(f.ctx, f.workflow, f.trigger)).rejects.toMatchObject({
      code: "ACTIONS_GITHUB_COMMAND_UNCERTAIN",
    });
    await expect(dispatchGitHubWorkflow(f.ctx, f.workflow, f.trigger)).rejects.toMatchObject({
      code: "ACTIONS_GITHUB_COMMAND_PENDING",
    });
    expect(h.dispatch).toHaveBeenCalledOnce();
  });
  it("retains the accepted run and Jobs association while its mirror is unavailable", async () => {
    const f = await fixture();
    const trigger = {
      ...f.trigger,
      sourceJob: { key: "job", label: "Scheduled CI", trigger: "schedule" },
    };
    h.sync.mockRejectedValueOnce(new Error("GitHub not visible yet"));
    await expect(dispatchGitHubWorkflow(f.ctx, f.workflow, trigger)).rejects.toMatchObject({
      code: "ACTIONS_GITHUB_SYNC_PENDING",
    });
    await expect(dispatchGitHubWorkflow(f.ctx, f.workflow, trigger)).resolves.toMatchObject({
      id: "mirrored-run",
    });
    const receipt = await h.repo.gitHubRunCommand(f.ctx.organizationId, f.workflow.id, "42", 1);
    expect(receipt.sourceJob).toEqual(trigger.sourceJob);
    expect(h.dispatch).toHaveBeenCalledOnce();
    await expect(
      dispatchGitHubWorkflow(f.ctx, f.workflow, { ...trigger, inputs: { version: "2" } }),
    ).rejects.toMatchObject({ code: "ACTIONS_REQUEST_KEY_REUSED" });
  });
  it("keeps a definitive rejection without retrying the POST", async () => {
    const f = await fixture();
    h.dispatch.mockRejectedValueOnce(
      Object.assign(new Error("workflow is invalid"), { status: 422 }),
    );
    await expect(dispatchGitHubWorkflow(f.ctx, f.workflow, f.trigger)).rejects.toThrow(
      "workflow is invalid",
    );
    await expect(dispatchGitHubWorkflow(f.ctx, f.workflow, f.trigger)).rejects.toMatchObject({
      code: "ACTIONS_GITHUB_COMMAND_REJECTED",
    });
    expect(h.dispatch).toHaveBeenCalledOnce();
  });
  it("does not cancel or rerun a newer GitHub attempt through a stale screen", async () => {
    const f = await fixture();
    const run = {
      id: "old",
      organizationId: f.ctx.organizationId,
      workflowId: f.workflow.id,
      attempt: 1,
      github: { id: "42" },
      configuration: { owner: "owner", repo: "test" },
    } as ActionRun;
    h.run.mockResolvedValue({ id: 42, run_attempt: 2, status: "in_progress" });
    await expect(controlGitHubRun(f.ctx, run, "cancel")).rejects.toMatchObject({
      code: "ACTIONS_RUN_CHANGED",
    });
    await expect(rerunGitHubWorkflow(f.ctx, run, "retry")).rejects.toMatchObject({
      code: "ACTIONS_RUN_ACTIVE",
    });
    expect(h.cancel).not.toHaveBeenCalled();
    expect(h.rerun).not.toHaveBeenCalled();
  });
});
