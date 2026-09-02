import { describe, expect, it, vi } from "vitest";
import type { Project, SwarmStack } from "@repo/db";

import { resolveStackSourceFiles } from "./swarm-source.service";

const project = {
  id: "project-blog",
  organizationId: "org-a",
  gitOwner: "acme",
  gitRepo: "blog",
  gitBranch: "main",
} as Project;

const repositoryStack = {
  id: "stack-blog",
  projectId: "project-blog",
  organizationId: "org-a",
  sourceKind: "repository",
  sourcePath: "deploy",
  sourcePaths: ["compose.yaml"],
  sourceBranch: "main",
  sourceCommitSha: "a1b2c3d",
} as unknown as SwarmStack;

describe("Swarm repository stack source", () => {
  it("reads only the linked repository's bounded source files into private manager-stage paths", async () => {
    const readRepositoryFile = vi.fn(async (...args: unknown[]) => {
      const [, owner, repo, path, options] = args as [unknown, string, string, string, unknown];
      if (path === "deploy/compose.yaml") {
        return {
          sha: "compose-sha",
          size: 102,
          content: "services:\n  web:\n    image: nginx:alpine\nconfigs:\n  app:\n    file: config/app.conf\n",
          download_url: null,
        };
      }
      if (path === "deploy/config/app.conf") {
        return { sha: "config-sha", size: 4, content: "safe", download_url: null };
      }
      throw new Error(`unexpected source path ${path}`);
    });

    await expect(resolveStackSourceFiles(repositoryStack, project, {} as never, { readRepositoryFile: readRepositoryFile as never })).resolves.toEqual({
      composePaths: ["compose.yaml"],
      files: [
        { path: "compose.yaml", content: expect.stringContaining("services:") },
        { path: "config/app.conf", content: "safe" },
      ],
    });
    expect(readRepositoryFile).toHaveBeenCalledTimes(2);
    expect(readRepositoryFile).toHaveBeenCalledWith(expect.anything(), "acme", "blog", "deploy/compose.yaml", { branch: "a1b2c3d" });
    expect(readRepositoryFile).toHaveBeenCalledWith(expect.anything(), "acme", "blog", "deploy/config/app.conf", { branch: "a1b2c3d" });
  });

  it("rejects an unsafe persisted repository path before any source read", async () => {
    const unsafe = { ...repositoryStack, sourcePaths: ["../compose.yaml"] } as SwarmStack;
    const readRepositoryFile = vi.fn();
    await expect(resolveStackSourceFiles(unsafe, project, {} as never, { readRepositoryFile }))
      .rejects.toMatchObject({ code: "SWARM_SOURCE_PATH_INVALID", statusCode: 400 });
    expect(readRepositoryFile).not.toHaveBeenCalled();
  });
});
