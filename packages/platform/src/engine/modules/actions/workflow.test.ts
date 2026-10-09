import { describe, expect, it } from "vitest";
import { actionRunnerMismatch, type ActionCapabilities, type ActionRunnerConfig } from "@repo/core";
import {
  actionConcurrency,
  actionPermissions,
  concreteJob,
  expandMatrix,
  parseActionWorkflow,
} from "./workflow";
import { evaluateJobCondition, evaluateTemplate } from "./expressions";

const context = { github: { ref: "refs/heads/main", repository: "acme/app" }, needs: {} };
const source = `name: CI
on: [push, workflow_dispatch]
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [20, 22]
    steps:
      - uses: actions/checkout@v4
      - run: echo hello
  deploy:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - run: echo done
`;

describe("Actions workflow planning", () => {
  it("validates GitHub YAML and preserves dependencies/matrix definitions", async () => {
    const plan = await parseActionWorkflow(source);
    expect(plan.name).toBe("CI");
    expect(plan.triggers).toEqual({ push: {}, workflow_dispatch: {} });
    expect(plan.jobs[1]!.needs).toEqual(["test"]);
    const jobs = expandMatrix(plan.jobs[0]!.matrix).map((matrix) =>
      concreteJob(plan.jobs[0]!, matrix, context, plan),
    );
    expect(jobs.map((j) => j.name)).toEqual(["test (20)", "test (22)"]);
    expect(jobs[0]!.timeoutSeconds).toBe(3600);
  });

  it("rejects invalid expressions, missing dependencies and cyclic graphs before dispatch", async () => {
    await expect(
      parseActionWorkflow(source.replace("needs: test", "needs: nonexistent")),
    ).rejects.toThrow();
    await expect(
      parseActionWorkflow(source.replace("test:\n", "test:\n    needs: deploy\n")),
    ).rejects.toThrow();
    await expect(
      parseActionWorkflow(source.replace("echo done", "echo ${{ unknown.value }}")),
    ).rejects.toThrow();
  });

  it("does not accept security features the execution engine cannot enforce", async () => {
    await expect(
      parseActionWorkflow(
        source.replace("needs: test", "needs: test\n    environment: production"),
      ),
    ).rejects.toThrow("protected environments");
    await expect(
      parseActionWorkflow(source.replace("[push, workflow_dispatch]", "pull_request_target")),
    ).rejects.toThrow("pull_request_target");
    expect(() => actionPermissions({ "id-token": "write" })).toThrow();
    expect(actionPermissions({ contents: "read", checks: "none" })).toEqual({ contents: "read" });
  });

  it("matches GitHub matrix include/exclude behavior, including additions that cannot merge", () => {
    const result = expandMatrix({
      fruit: ["apple", "pear"],
      animal: ["cat", "dog"],
      include: [
        { color: "green" },
        { color: "pink", animal: "cat" },
        { fruit: "banana" },
        { fruit: "banana", animal: "cat" },
      ],
      exclude: [{ fruit: "pear", animal: "dog" }],
    });
    expect(result).toEqual([
      { fruit: "apple", animal: "cat", color: "pink" },
      { fruit: "apple", animal: "dog", color: "green" },
      { fruit: "pear", animal: "cat", color: "pink" },
      { fruit: "banana" },
      { fruit: "banana", animal: "cat" },
    ]);
    expect(expandMatrix({ include: [{ os: "linux" }, { os: "macos" }] })).toEqual([
      { os: "linux" },
      { os: "macos" },
    ]);
    expect(expandMatrix({ n: [1], exclude: [{ n: 1 }] })).toEqual([]);
    expect(() =>
      expandMatrix({
        a: Array.from({ length: 17 }, (_, i) => i),
        b: Array.from({ length: 17 }, (_, i) => i),
      }),
    ).toThrow("256");
  });

  it("uses real Actions expression semantics for dynamic matrices and values", () => {
    const ctx = {
      ...context,
      needs: { generate: { result: "success", outputs: { matrix: '{"include":[{"node":22}]}' } } },
    };
    expect(evaluateTemplate("${{ fromJSON(needs.generate.outputs.matrix) }}", ctx)).toEqual({
      include: [{ node: 22 }],
    });
    expect(evaluateTemplate("ci-${{ github.ref }}", ctx)).toBe("ci-refs/heads/main");
    expect(evaluateTemplate("${{ format('}} {0}', 'ok') }}", ctx)).toBe("} ok");
    expect(
      actionConcurrency(
        {
          group: "CI-${{ github.ref }}",
          "cancel-in-progress": "${{ github.ref == 'refs/heads/main' }}",
        },
        ctx,
      ),
    ).toEqual({ group: "ci-refs/heads/main", cancelInProgress: true });
  });

  it("applies implicit success only when no status function is present", () => {
    const failed = { ...context, needs: { test: { result: "failure" } } };
    expect(evaluateJobCondition(undefined, failed)).toBe(false);
    expect(evaluateJobCondition("github.ref == 'refs/heads/main'", failed)).toBe(false);
    expect(evaluateJobCondition("always()", failed)).toBe(true);
    expect(evaluateJobCondition("failure()", failed)).toBe(true);
    expect(evaluateJobCondition("contains('always()', 'always')", failed)).toBe(false);
    expect(evaluateJobCondition("cancelled()", { ...context, cancelled: true })).toBe(true);
  });
});

describe("Actions destination capabilities", () => {
  const mac: ActionCapabilities = {
    os: "macos",
    architecture: "arm64",
    docker: false,
    git: true,
    node: true,
    distribution: null,
    version: "15.5",
  };
  const native: ActionRunnerConfig = {
    mode: "native",
    labels: [],
    image: null,
    maxParallel: 1,
    cpu: 2,
    memoryMb: 4096,
    allowDockerSocket: false,
  };
  it("allows a connected Mac to satisfy macOS jobs", () => {
    expect(
      actionRunnerMismatch(mac, native, {
        labels: ["self-hosted", "macos", "arm64"],
        requiresDocker: false,
      }),
    ).toBeNull();
    expect(
      actionRunnerMismatch(mac, native, { labels: ["macos-latest"], requiresDocker: false }),
    ).toBeNull();
  });
  it("does not send unsupported container or Linux jobs to a native Mac", () => {
    expect(
      actionRunnerMismatch(mac, native, { labels: ["macos-latest"], requiresDocker: true }),
    ).toContain("Docker");
    expect(
      actionRunnerMismatch(mac, native, { labels: ["ubuntu-latest"], requiresDocker: false }),
    ).toContain("ubuntu-latest");
    expect(actionRunnerMismatch(null, native, { labels: [], requiresDocker: false })).toContain(
      "capabilities",
    );
  });
});
