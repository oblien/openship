import { describe, expect, it } from "vitest";
import type { ActionJobView, ActionPlanView, ActionRunView } from "@repo/contracts";
import { workflowGraph, workflowGroupStatus } from "./workflow-graph";
import { jobProgress, type JobEvent } from "./job-progress";

const job = (
  id: string,
  key: string,
  status: ActionJobView["status"],
  phase: ActionJobView["phase"] = "running",
) => ({ id, jobKey: key, status, phase, labels: ["ubuntu-latest"] }) as ActionJobView;

describe("workflow presentation from durable state", () => {
  it("groups matrix executions without multiplying dependency edges", () => {
    const plan: ActionPlanView = {
      name: "CI",
      triggers: ["push"],
      inputs: [],
      jobs: [
        { id: "test", name: "Tests", runsOn: "ubuntu-latest", needs: [], requiresDocker: false },
        {
          id: "build",
          name: "Build",
          runsOn: "ubuntu-latest",
          needs: ["test"],
          requiresDocker: false,
        },
      ],
    };
    const jobs = Array.from({ length: 64 }, (_, i) =>
      job(`test-${i}`, "test", i === 5 ? "running" : "success"),
    );
    jobs.push(...Array.from({ length: 64 }, (_, i) => job(`build-${i}`, "build", "queued")));
    const graph = workflowGraph(plan, { id: "run-1", jobs } as ActionRunView);
    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toEqual([
      {
        id: "test:build",
        source: "test",
        target: "build",
        kind: "dependency",
        label: "",
        description: "test → build",
      },
    ]);
    expect(graph.nodes[0]).toMatchObject({
      state: "running",
      layoutColumn: 0,
      description: "Matrix × 64 · ubuntu-latest",
    });
    expect(graph.nodes[1]).toMatchObject({ state: "pending", layoutColumn: 1 });
  });

  it("distinguishes preparing, running and terminal matrix groups", () => {
    expect(workflowGroupStatus([job("1", "test", "running", "provisioning")])).toBe("provisioning");
    expect(workflowGroupStatus([job("1", "test", "success"), job("2", "test", "failure")])).toBe(
      "failure",
    );
    expect(workflowGroupStatus([job("1", "test", "skipped"), job("2", "test", "skipped")])).toBe(
      "skipped",
    );
    expect(workflowGroupStatus([])).toBeUndefined();
  });

  it("rebuilds step status after refresh and closes interrupted steps on cancellation", () => {
    const events = [
      { stepId: "install", step: "Install", stage: "Main", stepResult: "success" },
      { stepId: "test", step: "Tests", stage: "Main", message: "Starting" },
      { stepId: "cleanup", stage: "Post", stepResult: "success" },
    ] as JobEvent[];
    expect(jobProgress(events, { status: "running", steps: {} })).toEqual([
      { id: "install", name: "Install", status: "success" },
      { id: "test", name: "Tests", status: "running" },
    ]);
    expect(jobProgress(events, { status: "cancelled", steps: {} })[1]?.status).toBe("cancelled");
    expect(
      jobProgress(events, {
        status: "success",
        steps: { test: { conclusion: "success", outcome: "failure" } },
      })[1]?.status,
    ).toBe("success");
  });
});
