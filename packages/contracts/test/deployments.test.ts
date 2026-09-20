import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import {
  CreateDeploymentSchema,
  isCreateDeploymentResult,
  parseCreateDeploymentInput,
} from "../src";
import { deploymentFixture } from "./fixtures";

describe("deployment contract", () => {
  it("advertises all public controller/CLI flags without exposing internal pipeline controls", () => {
    expect(Object.keys(CreateDeploymentSchema.properties).sort()).toEqual([
      "branch",
      "commitSha",
      "environment",
      "forceAll",
      "projectId",
      "refresh",
      "serverId",
      "serviceIds",
      "smartRoute",
    ]);
    expect(
      Value.Check(CreateDeploymentSchema, {
        projectId: "p1",
        forceAll: true,
        smartRoute: true,
        refresh: false,
        serviceIds: ["s1"],
      }),
    ).toBe(true);
    expect(Value.Check(CreateDeploymentSchema, {})).toBe(false);
    expect(
      parseCreateDeploymentInput({
        projectId: "p1",
        reuseSnapshot: {},
        rollbackStrategy: "git",
        forcePullImages: true,
        handoverImages: [],
      }),
    ).toEqual({ projectId: "p1" });
  });

  it("accepts complete deployment records and compatible ID-only responses", () => {
    const ids = { deployment_id: "dep-project-a", project_id: "project-a" };
    expect(isCreateDeploymentResult(ids)).toBe(true);
    expect(
      isCreateDeploymentResult({ ...ids, deployment: deploymentFixture(), skipped: true }),
    ).toBe(true);
  });

  it.each([
    null,
    { deployment_id: "dep-project-a" },
    { deployment_id: "", project_id: "project-a" },
    { deployment_id: "dep-project-a", project_id: "project-a", skipped: "yes" },
    { deployment_id: "dep-project-a", project_id: "project-a", deployment: null },
    { deployment_id: "dep-project-a", project_id: "project-a", deployment: { id: "dep-project-a" } },
    { deployment_id: "wrong-id", project_id: "project-a", deployment: deploymentFixture() },
    { deployment_id: "dep-project-a", project_id: "wrong-project", deployment: deploymentFixture() },
    {
      deployment_id: "dep-project-a",
      project_id: "project-a",
      deployment: { ...deploymentFixture(), createdAt: 123 },
    },
  ])("rejects malformed or inconsistent deployment results: %j", (value) => {
    expect(isCreateDeploymentResult(value)).toBe(false);
  });
});
