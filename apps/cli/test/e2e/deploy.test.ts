import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../../src/lib/config", () => ({
  getApiUrl: () => "http://api.test",
  getToken: () => "tok",
}));

import { deployCommand } from "../../src/commands/deploy";
import { getShipClient } from "../../src/lib/ship-client";
import { runCommand, stubFetch, type FetchStub } from "../helpers/harness";

let fetchStub: FetchStub;
afterEach(() => fetchStub?.restore());

describe("openship deploy — registered server target (#763)", () => {
  it("sends --server through the normal deployment trigger", async () => {
    fetchStub = stubFetch((req) => {
      expect(req.url).toBe("http://api.test/api/deployments");
      expect(req.method).toBe("POST");
      expect(req.body).toMatchObject({
        projectId: "p1",
        branch: "main",
        commitSha: "abc123",
        environment: "production",
        serverId: "srv_remote",
      });
      return {
        json: {
          data: {
            deployment_id: "dep1",
            project_id: "p1",
          },
        },
      };
    });

    const { code, out, err } = await runCommand(deployCommand, [
      "--project",
      "p1",
      "--branch",
      "main",
      "--commit",
      "abc123",
      "--server",
      "srv_remote",
    ]);

    expect(code).toBe(0);
    expect(`${out}${err}`).toContain("dep1");
    expect(fetchStub.calls).toHaveLength(1);
  });

  it("carries --server through folder ensure and build/access", async () => {
    const sourceDir = mkdtempSync(join(tmpdir(), "openship-cli-target-"));
    writeFileSync(join(sourceDir, "index.html"), "ok");
    fetchStub = stubFetch((req) => {
      if (req.url.endsWith("/api/projects/folder/session")) {
        return {
          json: {
            success: true,
            sessionId: "folder-session",
            expiresAt: Date.now() + 60_000,
            upload: {
              url: "projects/folder/upload/folder-session", absoluteUrl: "http://api.test/api/projects/folder/upload/folder-session",
              method: "POST", headers: {}, requiresAuth: true, withCredentials: true,
            },
          },
        };
      }
      if (req.url.endsWith("/api/projects/folder/upload/folder-session")) {
        return new Response(null, { status: 200 });
      }
      if (req.url.endsWith("/api/projects/folder/scan/folder-session")) {
        return { json: {
          success: true, name: "folder-app", stack: "static", projectType: "app", packageManager: "npm",
          installCommand: "", buildCommand: "", startCommand: "", buildImage: "", outputDirectory: "", rootDirectory: "",
        } };
      }
      if (req.url.endsWith("/api/projects/ensure")) {
        expect(req.body).toMatchObject({ name: "folder-app", serverId: "srv_remote" });
        return { json: { success: true, project_id: "p-folder", created: true } };
      }
      if (req.url.endsWith("/api/deployments/build/access")) {
        expect(req.body).toMatchObject({
          projectId: "p-folder",
          uploadSessionId: "folder-session",
          deployTarget: "server",
          serverId: "srv_remote",
        });
        return { json: { success: true, deployment_id: "dep-folder", project_id: "p-folder" } };
      }
      throw new Error(`Unexpected request: ${req.method} ${req.url}`);
    });

    try {
      await expect(getShipClient().deploy({ source: { type: "directory", path: sourceDir }, serverId: "srv_remote" })).resolves.toMatchObject(
        { deployment_id: "dep-folder", project_id: "p-folder" },
      );
    } finally {
      rmSync(sourceDir, { recursive: true, force: true });
    }
  });
});
