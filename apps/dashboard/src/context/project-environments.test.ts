import { describe, expect, it } from "vitest";
import {
  firstProjectEnvironment,
  projectEnvironmentHref,
  projectEnvironmentIds,
  reconcileCreatedProjectEnvironment,
  removeProjectEnvironment,
  upsertProjectEnvironment,
} from "./project-environments";

type Environment = {
  id: string;
  type: "production" | "preview" | "development";
  name: string;
};

const production: Environment = { id: "prod", type: "production", name: "Production" };
const preview: Environment = { id: "preview", type: "preview", name: "Preview" };
const development: Environment = { id: "dev", type: "development", name: "Development" };

describe("project environment mutation state", () => {
  it("adds a created environment immediately without duplicating an existing id", () => {
    expect(upsertProjectEnvironment([production], preview)).toEqual([production, preview]);
    expect(
      upsertProjectEnvironment([production, preview], { ...preview, name: "Updated preview" }),
    ).toEqual([production, { ...preview, name: "Updated preview" }]);
  });

  it("keeps production first when it is created after another environment", () => {
    expect(upsertProjectEnvironment([development, preview], production)).toEqual([
      production,
      preview,
      development,
    ]);
  });

  it("removes only the deleted environment and selects the best surviving sibling", () => {
    const remaining = removeProjectEnvironment([preview, development, production], "preview");
    expect(remaining).toEqual([development, production]);
    expect(firstProjectEnvironment(remaining)).toEqual(production);
  });

  it("returns no destination after deleting the final environment", () => {
    const remaining = removeProjectEnvironment([production], "prod");
    expect(remaining).toEqual([]);
    expect(firstProjectEnvironment(remaining)).toBeNull();
  });

  it("deduplicates every affected cache id and preserves the active tab in navigation", () => {
    expect(projectEnvironmentIds("prod", [production, preview])).toEqual(["prod", "preview"]);
    expect(projectEnvironmentHref("preview", "deployments")).toBe("/projects/preview/deployments");
  });

  it("keeps a successful create committed when its reconciliation read fails", async () => {
    const commits: Environment[][] = [];
    const invalidations: string[][] = [];
    const refreshError = new Error("offline");
    const errors: unknown[] = [];

    await expect(
      reconcileCreatedProjectEnvironment({
        currentId: "prod",
        environments: [production],
        created: preview,
        refresh: async () => {
          throw refreshError;
        },
        commit: (next) => commits.push(next),
        invalidate: (ids) => invalidations.push(ids),
        onRefreshError: (error) => errors.push(error),
      }),
    ).resolves.toBeUndefined();

    expect(commits).toEqual([[production, preview]]);
    expect(invalidations).toEqual([["prod", "preview"]]);
    expect(errors).toEqual([refreshError]);
  });

  it("replaces the optimistic list with the canonical response", async () => {
    const commits: Environment[][] = [];
    const canonicalPreview = { ...preview, name: "Canonical preview" };

    await reconcileCreatedProjectEnvironment({
      currentId: "prod",
      environments: [production],
      created: preview,
      refresh: async () => [production, canonicalPreview, development],
      commit: (next) => commits.push(next),
      invalidate: () => undefined,
    });

    expect(commits).toEqual([
      [production, preview],
      [production, canonicalPreview, development],
    ]);
  });
});
