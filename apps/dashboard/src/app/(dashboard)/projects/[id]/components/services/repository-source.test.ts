import { describe, expect, it } from "vitest";
import { repositoryBuildFields, serviceRepositorySource } from "./repository-source";

const source = { owner: "example", repo: "project", branch: "main", projectDirectory: "." };
describe("repository service build fields", () => {
  it.each([
    [".", ".", "Dockerfile", ".", "Dockerfile"],
    ["deploy", "apps/api", "apps/api/docker/production", "../apps/api", "docker/production"],
    ["deploy/compose", ".", "docker/api.Dockerfile", "../..", "docker/api.Dockerfile"],
    ["apps", "apps/api", "apps/api/Dockerfile", "api", "Dockerfile"],
    ["apps/api", "apps/api", "apps/api/Dockerfile", ".", "Dockerfile"],
    ["./apps/", "./apps/api/", "./apps/api/Dockerfile", "api", "Dockerfile"],
    ["/", "apps/api", "apps/api/Dockerfile", "apps/api", "Dockerfile"],
    ["deploy\\compose", "apps/api", "apps/api/Dockerfile", "../../apps/api", "Dockerfile"],
  ])(
    "maps project %s, context %s and Dockerfile %s to existing Compose semantics",
    (projectDirectory, context, dockerfile, build, expectedFile) => {
      expect(repositoryBuildFields({ ...source, projectDirectory }, context, dockerfile)).toEqual({
        build,
        dockerfile: expectedFile,
      });
    },
  );
  it.each(["", "../outside", "api/../../etc", "/etc", "C:/temp", "api\\file", "a\nfile"])(
    "rejects unsafe or missing repository path %j",
    (path) => {
      expect(repositoryBuildFields(source, path, "Dockerfile")).toBe("invalidPath");
      expect(repositoryBuildFields(source, ".", path)).toBe("invalidPath");
    },
  );
  it("requires a Dockerfile inside the selected context, on a path boundary", () => {
    expect(repositoryBuildFields(source, "apps/api", "apps/api-other/Dockerfile")).toBe(
      "outsideContext",
    );
    expect(repositoryBuildFields(source, "apps/api", "Dockerfile")).toBe("outsideContext");
  });
  it("reads source metadata without relying on the Source tab having loaded", () => {
    expect(
      serviceRepositorySource({
        gitOwner: "example",
        gitRepo: "repo",
        gitBranch: "feature/api",
        rootDirectory: "deploy",
      }),
    ).toEqual({
      owner: "example",
      repo: "repo",
      branch: "feature/api",
      projectDirectory: "deploy",
    });
    expect(
      serviceRepositorySource({
        gitOwner: "example",
        gitRepo: "repo",
        options: { rootDirectory: "nested" },
      })?.projectDirectory,
    ).toBe("nested");
    expect(serviceRepositorySource({})).toBeNull();
    expect(serviceRepositorySource({ gitOwner: "local", gitRepo: "project" })).toBeNull();
    expect(
      serviceRepositorySource({ gitOwner: "example", gitRepo: "repo", gitProvider: "release" }),
    ).toBeNull();
  });
});


it("retains the project's server identity for repository browsing", () => {
  expect(serviceRepositorySource({ gitOwner: "example", gitRepo: "platform", serverId: "saved-server" }))
    .toMatchObject({ owner: "example", repo: "platform", serverId: "saved-server" });
});
