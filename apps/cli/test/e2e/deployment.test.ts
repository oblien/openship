import { afterEach, describe, expect, it, vi } from "vitest";

const { deployFolder } = vi.hoisted(() => ({ deployFolder: vi.fn() }));

vi.mock("node:child_process", () => ({ execFileSync: vi.fn(() => Buffer.from("false")) }));
vi.mock("../../src/lib/folder-deploy", () => ({ deployFolder }));

vi.mock("../../src/lib/config", () => ({
  getApiUrl: () => "http://api.test",
  getToken: () => "tok",
}));

import { deploymentCommand } from "../../src/commands/deployment";
import { deployCommand } from "../../src/commands/deploy";
import { runCommand, stubFetch, type FetchStub } from "../helpers/harness";

let fetchStub: FetchStub;
afterEach(() => fetchStub?.restore());

describe("openship deployment get", () => {
  it("GETs /deployments/:id and renders it", async () => {
    fetchStub = stubFetch(() => ({
      json: { data: { id: "dep1", status: "success", env: "production" } },
    }));
    const { out, code } = await runCommand(deploymentCommand, ["get", "dep1"]);
    expect(code).toBe(0);
    expect(fetchStub.calls[0].url).toBe("http://api.test/api/deployments/dep1");
    expect(out).toContain("dep1");
    expect(out).toContain("success");
  });
});

describe("openship deployment redeploy", () => {
  it("POSTs to /deployments/:id/redeploy", async () => {
    fetchStub = stubFetch(() => ({ json: { deploymentId: "dep2" } }));
    const { code } = await runCommand(deploymentCommand, ["redeploy", "dep1"]);
    expect(code).toBe(0);
    expect(fetchStub.calls[0].method).toBe("POST");
    expect(fetchStub.calls[0].url).toBe("http://api.test/api/deployments/dep1/redeploy");
  });
});

describe("openship deployment rollback", () => {
  it("POSTs to /deployments/:id/rollback", async () => {
    fetchStub = stubFetch(() => ({ json: { ok: true } }));
    const { code } = await runCommand(deploymentCommand, ["rollback", "dep1"]);
    expect(code).toBe(0);
    expect(fetchStub.calls[0].method).toBe("POST");
    expect(fetchStub.calls[0].url).toBe("http://api.test/api/deployments/dep1/rollback");
  });
});

describe("openship deploy", () => {
  it("targets a remote server", async () => {
    fetchStub = stubFetch(() => ({
      json: { data: { deployment_id: "dep1", project_id: "p1" } },
    }));
    const { code } = await runCommand(deployCommand, [
      "--project",
      "p1",
      "--branch",
      "main",
      "--commit",
      "abc123",
      "--server",
      "srv1",
    ]);
    expect(code).toBe(0);
    expect(fetchStub.calls[0].body).toMatchObject({
      projectId: "p1",
      serverId: "srv1",
    });
  });

  it("forwards the server to folder deployments", async () => {
    deployFolder.mockResolvedValue({ deploymentId: "dep1", projectId: "p1" });
    const { code } = await runCommand(deployCommand, ["--project", "p1", "--server", "srv1"]);
    expect(code).toBe(0);
    expect(deployFolder).toHaveBeenCalledWith(expect.objectContaining({ serverId: "srv1" }));
  });
});
