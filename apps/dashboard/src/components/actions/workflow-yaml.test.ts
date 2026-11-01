import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { editWorkflowTrigger, workflowTriggers, parseWorkflowPatterns } from "./workflow-yaml";

const source = `# Keep this workflow description
name: CI
on: [push, workflow_dispatch]
env:
  RELEASE: "\${{ github.sha }}"
jobs:
  test: # Keep this job comment
    runs-on: ubuntu-latest
    steps:
      - run: echo 'unchanged'
`;

describe("shared workflow trigger editor", () => {
  it("materializes shorthand and changes filters without changing jobs, expressions or comments", () => {
    const edited = editWorkflowTrigger(source, "push", {
      branches: ["main", "release/**", "!release/draft/**"],
      paths: ["src/**"],
    });
    const before = parse(source),
      after = parse(edited);
    expect(after.jobs).toEqual(before.jobs);
    expect(after.env).toEqual(before.env);
    expect(edited).toContain("# Keep this workflow description");
    expect(edited).toContain("# Keep this job comment");
    expect(workflowTriggers(edited)).toMatchObject({
      push: { branches: ["main", "release/**", "!release/draft/**"], paths: ["src/**"] },
      workflow_dispatch: {},
    });
  });
  it("preserves other events and their filters when toggling or removing an event", () => {
    const initial = `on:\n  push:\n    branches-ignore: [docs]\n  pull_request: # Keep PR policy\n    types: [opened, synchronize]\njobs: {}\n`;
    const webhook = editWorkflowTrigger(initial, "repository_dispatch", { types: ["release"] });
    const removed = editWorkflowTrigger(webhook, "push", undefined);
    expect(workflowTriggers(removed)).toEqual({
      pull_request: { types: ["opened", "synchronize"] },
      repository_dispatch: { types: ["release"] },
    });
    expect(removed).toContain("# Keep PR policy");
  });
  it("stores typed manual defaults and cron expressions without converting strings", () => {
    let edited = editWorkflowTrigger(source, "workflow_dispatch", {
      inputs: {
        ready: { type: "boolean", default: false },
        count: { type: "number", default: 3 },
        version: { type: "string", default: "001" },
      },
    });
    edited = editWorkflowTrigger(edited, "schedule", [{ cron: "*/15 * * * *" }]);
    expect(workflowTriggers(edited)).toMatchObject({
      schedule: [{ cron: "*/15 * * * *" }],
      workflow_dispatch: {
        inputs: { ready: { default: false }, count: { default: 3 }, version: { default: "001" } },
      },
    });
  });
  it("rejects malformed and duplicate YAML instead of dropping configuration", () => {
    expect(() => editWorkflowTrigger("on: [push", "push", {})).toThrow();
    expect(() => editWorkflowTrigger("on: push\non: workflow_dispatch", "push", {})).toThrow();
    expect(parseWorkflowPatterns("main\n\nrelease/**\r\n !release/draft/** ")).toEqual([
      "main",
      "release/**",
      "!release/draft/**",
    ]);
  });
});
