import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  addWorkflowJob,
  changeWorkflowSteps,
  editWorkflowDependency,
  editWorkflowJob,
  editWorkflowContainerImage,
  editWorkflowJobArchitecture,
  editWorkflowStep,
  removeWorkflowJob,
  workflowJobOffset,
} from "./workflow-editor";

const source = `# Production CI
name: CI
on: [push, workflow_dispatch]
permissions:
  contents: read
jobs:
  test: # keep this note
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [20, 22]
    steps:
      - uses: actions/checkout@v4 # pinned by repository
      - run: echo test
  publish:
    runs-on: ubuntu-latest
    needs: test
    steps:
      - run: echo publish
`;

describe("workflow canvas editing", () => {
  it("changes a job field while preserving matrix, permissions, other jobs and comments", () => {
    const result = editWorkflowJob(source, "test", "name", "Unit tests");
    expect(parse(result).jobs.test).toEqual({ ...parse(source).jobs.test, name: "Unit tests" });
    expect(parse(result).jobs.publish).toEqual(parse(source).jobs.publish);
    expect(parse(result).permissions).toEqual(parse(source).permissions);
    expect(result).toContain("# keep this note");
    expect(result).toContain("# pinned by repository");
    expect(result).toContain("# Production CI");
  });
  it("changes container images without losing credentials, options, volumes or comments", () => {
    const current = source.replace(
      "    runs-on: ubuntu-latest",
      "    runs-on: ubuntu-latest\n    container:\n      image: node:20 # keep image comment\n      credentials: {username: bot, password: '${{ secrets.REGISTRY_TOKEN }}'}\n      volumes: ['cache:/cache']\n      options: --user 1000",
    );
    const changed = editWorkflowContainerImage(current, "test", "node:24");
    expect(parse(changed).jobs.test.container).toEqual({
      ...parse(current).jobs.test.container,
      image: "node:24",
    });
    expect(changed).toContain("# keep image comment");
    const typing = editWorkflowContainerImage(changed, "test", "");
    expect(parse(typing).jobs.test.container.volumes).toEqual(["cache:/cache"]);
    expect(
      parse(editWorkflowJob(typing, "test", "container", undefined)).jobs.test.container,
    ).toBeUndefined();
  });
  it("selects architecture through standard runs-on labels without editing matrix expressions", () => {
    const arm = editWorkflowJobArchitecture(source, "test", "arm64");
    expect(parse(arm).jobs.test["runs-on"]).toEqual(["ubuntu-latest", "arm64"]);
    const x64 = editWorkflowJobArchitecture(arm, "test", "x64");
    expect(parse(x64).jobs.test["runs-on"]).toEqual(["ubuntu-latest", "x64"]);
    expect(parse(editWorkflowJobArchitecture(x64, "test", "auto")).jobs.test["runs-on"]).toEqual([
      "ubuntu-latest",
    ]);
    expect(parse(arm).jobs.test.strategy).toEqual(parse(source).jobs.test.strategy);
    expect(() =>
      editWorkflowJobArchitecture(
        source.replace("runs-on: ubuntu-latest", "runs-on: ${{ matrix.os }}"),
        "test",
        "arm64",
      ),
    ).toThrow("jobMapping");
  });
  it("creates independent job identities and edits dependency edges without duplicates", () => {
    const added = addWorkflowJob(source);
    const second = addWorkflowJob(added.source);
    expect(added.id).not.toBe(second.id);
    const connected = editWorkflowDependency(second.source, "test", added.id, true);
    expect(parse(connected).jobs[added.id].needs).toEqual(["test"]);
    expect(editWorkflowDependency(connected, "test", added.id, true)).toBe(connected);
    expect(
      parse(editWorkflowDependency(connected, "test", added.id, false)).jobs[added.id].needs,
    ).toBeUndefined();
  });
  it("rejects direct and transitive cycles and missing nodes before changing the draft", () => {
    const added = addWorkflowJob(source);
    const connected = editWorkflowDependency(added.source, "publish", added.id, true);
    expect(() => editWorkflowDependency(connected, added.id, "test", true)).toThrow("cycle");
    expect(() => editWorkflowDependency(source, "test", "test", true)).toThrow("cycle");
    expect(() => editWorkflowDependency(source, "missing", "test", true)).toThrow("missingJob");
    expect(parse(source).jobs.test.needs).toBeUndefined();
  });
  it("removes dependency edges when deleting a job but preserves other jobs", () => {
    const removed = removeWorkflowJob(source, "test");
    expect(parse(removed).jobs).toEqual({
      publish: { ...parse(source).jobs.publish, needs: undefined },
    });
    expect(() => removeWorkflowJob(removed, "publish")).toThrow("lastJob");
  });
  it("protects job outputs and result expressions from dangling references", () => {
    for (const expression of ["${{ needs.test.outputs.version }}", "${{ needs['test'].result }}"])
      expect(() =>
        removeWorkflowJob(source.replace("echo publish", `echo '${expression}'`), "test"),
      ).toThrow("referencedJob");
    expect(() =>
      removeWorkflowJob(
        source.replace(
          "    needs: test",
          "    needs: test\n    if: needs.test.result == 'success'",
        ),
        "test",
      ),
    ).toThrow("referencedJob");
    expect(() =>
      removeWorkflowJob(source.replace("echo publish", "echo needs.test"), "test"),
    ).not.toThrow();
  });
  it("edits and reorders steps without dropping action inputs or surrounding comments", () => {
    const edited = editWorkflowStep(source, "test", 0, { with: { "fetch-depth": 0 } });
    const moved = changeWorkflowSteps(edited, "test", 0, "down");
    expect(parse(moved).jobs.test.steps[1]).toEqual({
      uses: "actions/checkout@v4",
      with: { "fetch-depth": 0 },
    });
    expect(moved).toContain("# pinned by repository");
    const added = changeWorkflowSteps(moved, "test", 0, "add");
    expect(parse(added).jobs.test.steps).toHaveLength(3);
    expect(parse(changeWorkflowSteps(added, "test", 1, "remove")).jobs.test.steps).toHaveLength(2);
    expect(parse(moved).jobs.publish).toEqual(parse(source).jobs.publish);
  });
  it("locates a selected job in the same full-workflow YAML without copying it", () => {
    const position = workflowJobOffset(source, "test");
    expect(source.slice(position)).toMatch(/^runs-on: ubuntu-latest/);
  });
  it("keeps an action step in action mode while its reference is being replaced", () => {
    const cleared = editWorkflowStep(source, "test", 0, { uses: "" });
    expect(parse(cleared).jobs.test.steps[0]).toHaveProperty("uses", "");
    const edited = editWorkflowStep(cleared, "test", 0, { uses: "actions/setup-node@v4" });
    expect(parse(edited).jobs.test.steps[0].uses).toBe("actions/setup-node@v4");
    const command = editWorkflowStep(edited, "test", 0, { uses: undefined, run: "echo done" });
    expect(parse(command).jobs.test.steps[0]).toEqual({ run: "echo done" });
  });
});
