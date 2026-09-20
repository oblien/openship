import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { resolveFromLocalMock, resolveSourceEnvFromLocalMock } = vi.hoisted(() => ({
  resolveFromLocalMock: vi.fn(),
  resolveSourceEnvFromLocalMock: vi.fn(),
}));

vi.mock("@repo/platform/engine/modules/deployments/local-source", () => ({
  resolveFromLocal: resolveFromLocalMock,
  resolveSourceEnvFromLocal: resolveSourceEnvFromLocalMock,
}));

import { resolveFolderSessionSourceEnv, scanFolderSession } from "@repo/platform/engine/modules/projects/folder/folder.service";
import type { FolderSession } from "@repo/platform/engine/modules/projects/folder/session-store";

describe("scanFolderSession", () => {
  let stagingDir: string;

  beforeEach(async () => {
    resolveFromLocalMock.mockReset();
    resolveSourceEnvFromLocalMock.mockReset();
    stagingDir = await mkdtemp(join(tmpdir(), "openship-folder-scan-"));
  });

  afterEach(async () => {
    await rm(stagingDir, { recursive: true, force: true });
  });

  function session(services: FolderSession["services"]): FolderSession {
    return {
      id: "folder-session",
      orgId: "org-1",
      userId: "user-1",
      mode: "api-relay",
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      stagingDir,
      uploaded: true,
      services,
    };
  }

  it("keeps the initial scan as the edit baseline during a final-env refresh", async () => {
    const initial = [{ name: "api", image: "ghcr.io/acme/api:" }];
    const refreshed = [{ name: "api", image: "ghcr.io/acme/api:1.2.3" }];
    const upload = session(initial as FolderSession["services"]);
    resolveFromLocalMock.mockResolvedValue({ services: refreshed });

    const result = await scanFolderSession(upload, {
      env: { MY_VERSION: "1.2.3" },
      composePath: "deploy/compose.yaml",
      rememberServices: false,
    });

    expect(resolveFromLocalMock).toHaveBeenCalledWith(stagingDir, {
      env: { MY_VERSION: "1.2.3" },
      composePath: "deploy/compose.yaml",
    });
    expect(result.services).toBe(refreshed);
    expect(upload.services).toBe(initial);
  });

  it("remembers a normal client-visible scan", async () => {
    const initial = [{ name: "api", image: "ghcr.io/acme/api:" }];
    const refreshed = [{ name: "api", image: "ghcr.io/acme/api:1.2.3" }];
    const upload = session(initial as FolderSession["services"]);
    resolveFromLocalMock.mockResolvedValue({ services: refreshed });

    await scanFolderSession(upload);

    expect(upload.services).toBe(refreshed);
  });

  it("reads source env without running the full project scanner", async () => {
    const upload = session(undefined);
    resolveSourceEnvFromLocalMock.mockResolvedValue({
      openshipEnv: { NEXT_PUBLIC_API_URL: "https://api.example.com" },
    });

    await expect(resolveFolderSessionSourceEnv(upload, "apps/web")).resolves.toEqual({
      openshipEnv: { NEXT_PUBLIC_API_URL: "https://api.example.com" },
    });

    expect(resolveSourceEnvFromLocalMock).toHaveBeenCalledWith(stagingDir, "apps/web");
    expect(resolveFromLocalMock).not.toHaveBeenCalled();
  });
});
