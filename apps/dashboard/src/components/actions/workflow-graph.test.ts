import { describe, expect, it } from "vitest";
import type { ActionJobView, ActionPlanView, ActionRunView } from "@repo/contracts";
import {
  workflowGraph,
  workflowDetailGraph,
  workflowGroupStatus,
  WORKFLOW_NODE_LAYOUT,
} from "./workflow-graph";
import { changeWorkflowSteps, workflowJobs } from "./workflow-editor";
import { topologyPositions } from "@/components/topology/model";
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
        targetGutter: WORKFLOW_NODE_LAYOUT.gapX / 2,
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
  it("presents GitHub step names and live state without an independent log journal", () => {
    expect(
      jobProgress([], {
        status: "running",
        steps: {
          "1": { name: "Check out repository", outcome: "success", conclusion: "success" },
          "2": { name: "Build", outcome: "running", conclusion: "running" },
          "3": { name: "Release", outcome: "queued", conclusion: "queued" },
        },
      }),
    ).toEqual([
      { id: "1", name: "Check out repository", status: "success" },
      { id: "2", name: "Build", status: "running" },
      { id: "3", name: "Release", status: "queued" },
    ]);
  });
});

describe("workflow step topology", () => {
  const source = `jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Install
        run: npm ci
      - name: Lint
        run: npm run lint
      - name: Test
        run: npm test
      - name: Report
        uses: actions/upload-artifact@v4
  docs:
    runs-on: ubuntu-latest
    steps:
      - run: npm run docs
  build:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - run: npm run build
`;
  const plan: ActionPlanView = {
    name: "CI",
    triggers: ["push"],
    inputs: [],
    jobs: [
      { id: "test", name: "Test", runsOn: "ubuntu-latest", needs: [], requiresDocker: false },
      { id: "docs", name: "Docs", runsOn: "ubuntu-latest", needs: [], requiresDocker: false },
      {
        id: "build",
        name: "Build",
        runsOn: "ubuntu-latest",
        needs: ["test"],
        requiresDocker: false,
      },
    ],
  };

  it("keeps job dependencies and renders step order as separate cards with directional edges", () => {
    const base = workflowGraph(plan);
    const expanded = workflowDetailGraph(base, workflowJobs(source), ["test", "docs"], "Command");
    expect(expanded.edges.filter((edge) => edge.kind === "dependency")).toEqual(base.edges);
    expect(
      expanded.nodes.filter((node) => node.workflowStep?.jobId === "test").map((node) => node.name),
    ).toEqual(["Checkout", "Install", "Lint", "Test", "Report"]);
    expect(expanded.nodes.find((node) => node.name === "Checkout")).toMatchObject({
      kind: "workflow-step",
      workflowStep: { jobId: "test", index: 0, kind: "action" },
    });
    const sequence = expanded.edges.filter(
      (edge) => edge.kind === "sequence" && edge.id.startsWith("test:"),
    );
    expect(sequence.map(({ source, target }) => [source, target])).toEqual([
      ["test", "test:step:0"],
      ["test:step:0", "test:step:1"],
      ["test:step:1", "test:step:2"],
      ["test:step:2", "test:step:3"],
      ["test:step:3", "test:step:4"],
    ]);
    const positions = topologyPositions(expanded, WORKFLOW_NODE_LAYOUT);
    expect(positions.test.y).toBe(positions.build.y);
    for (const edge of sequence) {
      const from = positions[edge.source];
      const to = positions[edge.target];
      if (edge.source === "test") {
        expect(edge.sourceHandle).toBe("steps");
        expect(to.y).toBeGreaterThan(from.y);
      } else if (from.y === to.y) {
        expect(edge.sourceHandle).toBe(to.x > from.x ? "right-out" : "left-out");
        expect(edge.targetHandle).toBe(to.x > from.x ? "left-in" : "right-in");
      } else {
        expect(to.x).toBe(from.x);
        expect(to.y).toBeGreaterThan(from.y);
        expect(edge.sourceHandle).toBe("bottom-out");
        expect(edge.targetHandle).toBe("top-in");
      }
    }
    expect(sequence.every((edge) => edge.readOnly)).toBe(true);
    const collapsed = workflowDetailGraph(base, workflowJobs(source), ["docs"], "Command");
    expect(collapsed.nodes.some((node) => node.workflowStep?.jobId === "test")).toBe(false);
    expect(collapsed.nodes.some((node) => node.workflowStep?.jobId === "docs")).toBe(true);
    expect(collapsed.nodes.find((node) => node.id === "test")).toMatchObject(base.nodes[0]);
  });

  it("keeps jobs compact, positions steps beneath them and leaves every card clear of its neighbors", () => {
    const base = workflowGraph(plan);
    const expanded = workflowDetailGraph(base, workflowJobs(source), ["test", "docs"], "Command");
    const positions = topologyPositions(expanded, WORKFLOW_NODE_LAYOUT);
    expect(expanded.nodes.every((node) => !node.parentId)).toBe(true);
    for (const node of expanded.nodes) {
      expect(positions[node.id]).toEqual(node.layoutPosition);
      if (node.workflowStep) {
        expect(positions[node.id].y).toBeGreaterThan(
          positions[node.workflowStep.jobId].y + WORKFLOW_NODE_LAYOUT.height,
        );
      } else {
        expect(node.layoutWidth ?? WORKFLOW_NODE_LAYOUT.width).toBe(WORKFLOW_NODE_LAYOUT.width);
        expect(node.layoutHeight ?? WORKFLOW_NODE_LAYOUT.height).toBe(WORKFLOW_NODE_LAYOUT.height);
      }
    }
    for (const [index, node] of expanded.nodes.entries()) {
      const position = positions[node.id];
      for (const other of expanded.nodes.slice(index + 1)) {
        const next = positions[other.id];
        const overlaps =
          position.x < next.x + (other.layoutWidth ?? WORKFLOW_NODE_LAYOUT.width) &&
          next.x < position.x + (node.layoutWidth ?? WORKFLOW_NODE_LAYOUT.width) &&
          position.y < next.y + (other.layoutHeight ?? WORKFLOW_NODE_LAYOUT.height) &&
          next.y < position.y + (node.layoutHeight ?? WORKFLOW_NODE_LAYOUT.height);
        expect(overlaps, `${node.id} overlaps ${other.id}`).toBe(false);
      }
    }
    const collapsed = workflowDetailGraph(base, workflowJobs(source), [], "Command");
    expect(topologyPositions(collapsed, WORKFLOW_NODE_LAYOUT)).toEqual(
      topologyPositions(base, WORKFLOW_NODE_LAYOUT),
    );
  });

  it("reflows a long single job into the available aspect ratio without changing its steps or dependencies", () => {
    const longSource = `jobs:\n  test:\n    steps:\n${Array.from({ length: 12 }, (_, index) => `      - run: echo step-${index + 1}\n`).join("")}`;
    const base = workflowGraph({ ...plan, jobs: [plan.jobs[0]] });
    const jobs = workflowJobs(longSource);
    const wide = workflowDetailGraph(base, jobs, ["test"], "Command", { width: 1280, height: 720 });
    const tall = workflowDetailGraph(base, jobs, ["test"], "Command", { width: 600, height: 1100 });
    const wideSteps = wide.nodes.filter((node) => node.workflowStep);
    const tallSteps = tall.nodes.filter((node) => node.workflowStep);
    expect(new Set(wideSteps.map((node) => node.layoutPosition!.x)).size).toBeGreaterThan(2);
    expect(new Set(tallSteps.map((node) => node.layoutPosition!.x)).size).toBeLessThan(
      new Set(wideSteps.map((node) => node.layoutPosition!.x)).size,
    );
    expect(wideSteps.map((node) => node.name)).toEqual(tallSteps.map((node) => node.name));
    expect(wide.edges.map(({ source, target }) => [source, target])).toEqual(
      tall.edges.map(({ source, target }) => [source, target]),
    );
    expect(base.nodes).toHaveLength(1);
    expect(base.nodes[0]).not.toHaveProperty("layoutPosition");
  });

  it("takes reordered and deleted steps from the same YAML without retaining orphan nodes or edges", () => {
    const reordered = changeWorkflowSteps(source, "test", 4, "up");
    const removed = changeWorkflowSteps(reordered, "test", 0, "remove");
    const graph = workflowDetailGraph(
      workflowGraph(plan),
      workflowJobs(removed),
      ["test"],
      "Command",
    );
    expect(
      graph.nodes.filter((node) => node.workflowStep?.jobId === "test").map((node) => node.name),
    ).toEqual(["Install", "Lint", "Report", "Test"]);
    const ids = new Set(graph.nodes.map((node) => node.id));
    expect(graph.edges.every((edge) => ids.has(edge.source) && ids.has(edge.target))).toBe(true);
    expect(graph.edges.filter((edge) => edge.kind === "sequence")).toHaveLength(4);
  });
});
