import { describe, expect, it } from "vitest";
import {
  deploymentMayBecomeActive,
  selectDeploymentEnvironmentProject,
  type EnvironmentProject,
} from "../../../src/modules/deployments/deployment-environment";

function project(overrides: Partial<EnvironmentProject> = {}): EnvironmentProject {
  return {
    id: "prod",
    environmentSlug: "production",
    environmentType: "production",
    gitBranch: "main",
    ...overrides,
  };
}

describe("deployment environment routing", () => {
  it("uses the branch to disambiguate multiple preview project rows", () => {
    const production = project();
    const first = project({
      id: "preview-one",
      environmentSlug: "feature-one",
      environmentType: "preview",
      gitBranch: "feature/one",
    });
    const second = project({
      id: "preview-two",
      environmentSlug: "feature-two",
      environmentType: "preview",
      gitBranch: "feature/two",
    });

    expect(
      selectDeploymentEnvironmentProject(
        production,
        [production, first, second],
        "preview",
        "feature/two",
      ),
    ).toEqual({ status: "matched", project: second });
  });

  it("reports an ambiguous preview selector when no branch identifies one row", () => {
    const production = project();
    const first = project({
      id: "preview-one",
      environmentSlug: "feature-one",
      environmentType: "preview",
      gitBranch: "feature/one",
    });
    const second = project({
      id: "preview-two",
      environmentSlug: "feature-two",
      environmentType: "preview",
      gitBranch: "feature/two",
    });

    const result = selectDeploymentEnvironmentProject(production, [first, second], "preview");
    expect(result.status).toBe("ambiguous");
  });

  it("never lets an explicitly preview deployment activate production", () => {
    expect(deploymentMayBecomeActive(project(), "preview")).toBe(false);
  });

  it("allows preview activation on its isolated project row", () => {
    const preview = project({
      id: "preview",
      environmentSlug: "feature-one",
      environmentType: "preview",
      gitBranch: "feature/one",
    });

    expect(deploymentMayBecomeActive(preview, "preview")).toBe(true);
    // Preserve existing rows whose legacy deployment.environment defaulted to production.
    expect(deploymentMayBecomeActive(preview, "production")).toBe(true);
  });
});
