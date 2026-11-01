import { describe, expect, it, vi } from "vitest";
import type { ActionRun } from "@repo/db";
import {
  calledInputs,
  calledPermissions,
  calledSecrets,
  snapshotActionWorkflows,
} from "./reusable";

const root = {
  owner: "acme",
  repo: "app",
  path: ".openship/workflows/ci.yml",
  sha: "a".repeat(40),
  ref: "refs/heads/main",
};
const leaf = `on:
  workflow_call:
    inputs:
      enabled: {type: boolean, default: false}
      count: {type: number, required: true}
    secrets:
      deploy: {required: true}
    outputs:
      artifact: {value: '\${{ jobs.build.outputs.name }}'}
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hello
`;
describe("immutable reusable workflow sources", () => {
  it("pins repeated remote references once for the whole approved attempt", async () => {
    const source =
      "on: workflow_dispatch\njobs:\n  first:\n    uses: acme/lib/.github/workflows/build.yml@v1\n    with: {count: 1}\n  second:\n    uses: acme/lib/.github/workflows/build.yml@v1\n    with: {count: 2}\n";
    const read = vi.fn(async () => ({ ...root, repo: "lib", source: leaf }));
    const snapshots = await snapshotActionWorkflows({ ...root, source }, read);
    expect(read).toHaveBeenCalledTimes(1);
    expect(snapshots.root!.calls.first).toBe(snapshots.root!.calls.second);
  });
  it("keeps independent reusable files in .openship/workflows", async () => {
    const source =
      "on: workflow_dispatch\njobs:\n  call:\n    uses: ./.openship/workflows/build.yml\n    with: {count: 2}\n    secrets: {deploy: '${{ secrets.DEPLOY }}'}\n";
    const snapshots = await snapshotActionWorkflows({ ...root, source }, async () => ({
      ...root,
      path: ".openship/workflows/build.yml",
      source: leaf,
    }));
    expect(snapshots[snapshots.root!.calls.call!]!.path).toBe(".openship/workflows/build.yml");
  });
  it("captures source once, validates workflow_call and retains input types", async () => {
    const source = `on: workflow_dispatch
jobs:
  call:
    uses: ./.github/workflows/build.yml
    with: {count: 2}
    secrets: {deploy: '\${{ secrets.DEPLOY }}'}
`;
    const read = vi.fn(async () => ({
      ...root,
      path: ".github/workflows/build.yml",
      source: leaf,
    }));
    const snapshots = await snapshotActionWorkflows({ ...root, source }, read);
    expect(Object.keys(snapshots)).toHaveLength(2);
    const call = snapshots[snapshots.root!.calls.call!]!;
    expect(call.sha).toBe(root.sha);
    expect(calledInputs(call.plan.triggers.workflow_call, { count: 2 }, { github: {} })).toEqual({
      enabled: false,
      count: 2,
    });
    expect(() =>
      calledInputs(call.plan.triggers.workflow_call, { count: "2" }, { github: {} }),
    ).toThrow("must be a number");
  });
  it("rejects cycles and undeclared inputs before executing any job", async () => {
    const source = "on: workflow_call\njobs:\n  loop:\n    uses: ./.github/workflows/ci.yml\n";
    await expect(
      snapshotActionWorkflows({ ...root, source }, async () => ({ ...root, source })),
    ).rejects.toThrow("cycle");
    await expect(
      snapshotActionWorkflows(
        {
          ...root,
          source:
            "on: workflow_dispatch\njobs:\n  call:\n    uses: acme/lib/.github/workflows/build.yml@v1\n    with: {wrong: true}\n",
        },
        async () => ({ ...root, repo: "lib", source: leaf }),
      ),
    ).rejects.toThrow("unknown workflow input");
  });
  it("rejects cross-owner secret inheritance and permission escalation", async () => {
    const source =
      "on: workflow_dispatch\njobs:\n  call:\n    uses: other/lib/.github/workflows/build.yml@v1\n    with: {count: 1}\n    secrets: inherit\n";
    await expect(
      snapshotActionWorkflows({ ...root, source }, async () => ({
        ...root,
        owner: "other",
        source: leaf,
      })),
    ).rejects.toThrow("same account");
    expect(calledPermissions(undefined, { contents: "read" })).toEqual({ contents: "read" });
    expect(() => calledPermissions({ contents: "write" }, { contents: "read" })).toThrow(
      "increase",
    );
    expect(() => calledPermissions({ "id-token": "write" }, { contents: "write" })).toThrow(
      "increase",
    );
    expect(
      calledPermissions({ contents: "read" }, { contents: "write", "id-token": "write" }),
    ).toEqual({ contents: "read" });
  });
  it("forwards only explicitly mapped secrets and fails required missing secrets", () => {
    const run = {
      event: {},
      configuration: {
        workflows: {
          child: {
            plan: { triggers: { workflow_call: { secrets: { deploy: { required: true } } } } },
          },
        },
        variables: {},
      },
      plan: { name: "CI" },
      ref: "refs/heads/main",
    } as unknown as ActionRun;
    const frame = {
      jobId: "call",
      sourceId: "child",
      name: "call",
      inputs: {},
      permissions: {},
      caller: { inputs: {}, matrix: {}, needs: {}, strategy: {} },
      secrets: { deploy: "${{ secrets.DEPLOY }}" },
    };
    expect(
      calledSecrets(run, [frame], { DEPLOY: "secret", PRIVATE: "hidden", GITHUB_TOKEN: "old" }),
    ).toEqual({ deploy: "secret" });
    expect(() => calledSecrets(run, [frame], {})).toThrow("Required workflow secret deploy");
    for (const expression of ["${{ secrets.GITHUB_TOKEN }}", "${{ github.token }}"])
      expect(
        calledSecrets(
          run,
          [{ ...frame, secrets: { deploy: expression } }],
          {},
          "leaf-scoped-token",
        ),
      ).toEqual({ deploy: "leaf-scoped-token" });
  });
});
