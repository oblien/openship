import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand, stubFetch, type FetchStub } from "../helpers/harness";

vi.mock("../../src/lib/config", () => ({
  getApiUrl: () => "http://api.test",
  getToken: () => "tok",
}));
const gitState = vi.hoisted(() => ({ inRepo: false }));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: (...args: Parameters<typeof actual.execFileSync>) => {
      if (args[0] === "git") {
        if (gitState.inRepo) return Buffer.from("true");
        throw new Error("not a Git repository");
      }
      return actual.execFileSync(...args);
    },
  };
});
vi.mock("../../src/lib/project-link", () => ({ readProjectLink: () => null }));

describe("deploy requires folder upload opt-in (#853)", () => {
  let fetchStub: FetchStub;
  beforeEach(() => {
    vi.resetModules();
    gitState.inRepo = false;
  });
  afterEach(() => {
    fetchStub?.restore();
    vi.restoreAllMocks();
  });

  it.each([
    { flags: ["--folder"], inRepo: true },
    { flags: ["--name", "local-app"], inRepo: false },
  ])("uploads source with explicit opt-in: $flags", async ({ flags, inRepo }) => {
    const sourceDir = mkdtempSync(join(tmpdir(), "openship-folder-command-"));
    writeFileSync(join(sourceDir, "index.html"), "site");
    vi.spyOn(process, "cwd").mockReturnValue(sourceDir);
    gitState.inRepo = inRepo;
    fetchStub = stubFetch((req) => {
      if (req.url.endsWith("/projects/folder/session")) {
        return {
          json: {
            sessionId: "session-1",
            expiresAt: Date.now() + 60_000,
            upload: {
              url: "/folder-upload",
              absoluteUrl: "http://api.test/folder-upload",
              method: "POST",
              headers: {},
              requiresAuth: true,
              withCredentials: true,
            },
          },
        };
      }
      if (req.url.endsWith("/folder-upload")) return { json: { success: true } };
      if (req.url.endsWith("/projects/folder/scan/session-1"))
        return {
          json: {
            success: true,
            name: "local-app",
            stack: "static",
            projectType: "app",
            packageManager: "npm",
            installCommand: "",
            buildCommand: "",
            startCommand: "",
            buildImage: "",
            outputDirectory: "",
            rootDirectory: "",
          },
        };
      if (req.url.endsWith("/projects/ensure")) {
        expect(req.body).toMatchObject({ projectId: "p1", gitProvider: "upload" });
        return { json: { success: true, project_id: "p1", created: false } };
      }
      if (req.url.endsWith("/deployments/build/access")) {
        expect(req.body).toMatchObject({
          projectId: "p1",
          uploadSessionId: "session-1",
          serviceIds: ["svc1"],
        });
        return { json: { success: true, deployment_id: "d1", project_id: "p1" } };
      }
      throw new Error(`Unexpected endpoint: ${req.url}`);
    });
    try {
      const { deployCommand } = await import("../../src/commands/deploy");
      const result = await runCommand(deployCommand, [
        ...flags,
        "--project",
        "p1",
        "--service-ids",
        "svc1",
      ]);
      expect(result.code).toBe(0);
      expect(result.out + result.err).toContain("d1");
      expect(fetchStub.calls).toHaveLength(5);
    } finally {
      rmSync(sourceDir, { recursive: true, force: true });
    }
  });

  it("does not provision an upload without a source or project opt-in outside Git", async () => {
    fetchStub = stubFetch(() => {
      throw new Error("must not send a request");
    });
    const { deployCommand } = await import("../../src/commands/deploy");
    const result = await runCommand(deployCommand, []);
    expect(result.code).toBe(1);
    expect(result.err).toContain("--folder");
    expect(fetchStub.calls).toEqual([]);
  });

  it("redeploys an explicit project from outside Git without uploading the working directory", async () => {
    fetchStub = stubFetch((req) => {
      expect(req.url).toBe("http://api.test/api/deployments");
      expect(req.body).toMatchObject({ projectId: "p1", serviceIds: ["svc1"] });
      expect(req.body).not.toHaveProperty("branch");
      return { json: { data: { deployment_id: "dep1", project_id: "p1" } } };
    });
    const { deployCommand } = await import("../../src/commands/deploy");
    expect(
      (await runCommand(deployCommand, ["--project", "p1", "--service-ids", "svc1"])).code,
    ).toBe(0);
    expect(fetchStub.calls).toHaveLength(1);
  });

  it("uses the Git deployment endpoint for an explicit remote branch", async () => {
    fetchStub = stubFetch((req) => {
      expect(req.url).toBe("http://api.test/api/deployments");
      expect(req.body).toMatchObject({ projectId: "p1", branch: "main", serviceIds: ["svc1"] });
      return { json: { data: { deployment_id: "dep1", project_id: "p1" } } };
    });
    const { deployCommand } = await import("../../src/commands/deploy");
    const result = await runCommand(deployCommand, [
      "--project",
      "p1",
      "--branch",
      "main",
      "--service-ids",
      "svc1",
    ]);
    expect(result.code).toBe(0);
    expect(fetchStub.calls).toHaveLength(1);
  });

  it("rejects Git-only options with --folder before making requests", async () => {
    fetchStub = stubFetch(() => {
      throw new Error("must not send a request");
    });
    const { deployCommand } = await import("../../src/commands/deploy");
    const result = await runCommand(deployCommand, ["--folder", "--commit", "abc123"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("cannot be combined");
    expect(fetchStub.calls).toEqual([]);
  });
});
