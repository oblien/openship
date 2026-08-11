import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/config", () => ({
  getApiUrl: () => "http://api.test",
  getToken: () => "tok",
}));

import { deploymentCommand } from "../../src/commands/deployment";
import { runCommand, stubFetch, type FetchStub } from "../helpers/harness";

let fetchStub: FetchStub;
afterEach(() => fetchStub?.restore());

describe("openship deployment list", () => {
  it("scopes the query by project and environment, and renders the rows", async () => {
    fetchStub = stubFetch(() => ({
      json: {
        data: [
          {
            id: "dep1",
            status: "ready",
            environment: "production",
            branch: "main",
            commitSha: "abcdef1234567890",
            isActive: true,
            createdAt: "2024-01-01T00:00:00Z",
          },
        ],
      },
    }));
    const { out, code } = await runCommand(deploymentCommand, [
      "list",
      "--project",
      "p1",
      "--env",
      "production",
      "--limit",
      "10",
    ]);
    expect(code).toBe(0);
    expect(fetchStub.calls[0].url).toBe(
      "http://api.test/api/deployments?projectId=p1&environment=production&perPage=10",
    );
    expect(out).toContain("dep1");
    expect(out).toContain("abcdef1"); // commit column is the short sha
  });

  it("clamps --limit to the API's 100-row ceiling", async () => {
    fetchStub = stubFetch(() => ({ json: { data: [] } }));
    const { code } = await runCommand(deploymentCommand, [
      "list",
      "--project",
      "p1",
      "--limit",
      "500",
    ]);
    expect(code).toBe(0);
    expect(fetchStub.calls[0].url).toContain("perPage=100");
  });
});

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
