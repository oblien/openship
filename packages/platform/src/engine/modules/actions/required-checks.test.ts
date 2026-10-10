import { beforeAll, describe, expect, it } from "vitest";
import type { ActionWorkflowPlan } from "@repo/core";
import { parseActionWorkflow } from "./workflow";
import { assertRequiredPushWorkflow } from "./required-checks";

let plan: ActionWorkflowPlan;
beforeAll(async () => {
  plan = await parseActionWorkflow(
    "name: CI\non: push\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo checked\n",
  );
});

describe("required deployment check coverage", () => {
  it.each([
    { push: {} },
    { push: { branches: ["main"] } },
    { push: { branches: ["**", "!docs/**"], tags: ["v*"] } },
  ])("accepts a workflow covering every push to main: %j", (triggers) => {
    expect(() => assertRequiredPushWorkflow({ ...plan, triggers }, "main")).not.toThrow();
  });

  it.each([
    { pull_request: {} },
    { workflow_dispatch: {} },
    { push: { branches: ["release/**"] } },
    { push: { branches: ["**", "!main"] } },
    { push: { "branches-ignore": ["main"] } },
    { push: { tags: ["v*"] } },
    { push: { paths: ["src/**"] } },
    { push: { "paths-ignore": ["docs/**"] } },
  ])("rejects rules that can leave a deployment waiting forever: %j", (triggers) => {
    expect(() => assertRequiredPushWorkflow({ ...plan, triggers }, "main")).toThrow();
  });
});
