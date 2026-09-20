import { afterEach, describe, expect, it, vi } from "vitest";
import { deploymentFixture } from "../../../../packages/contracts/test/fixtures";

vi.mock("../../src/lib/config", () => ({
  getApiUrl: () => "http://api.test",
  getToken: () => "tok",
}));

import { deploymentCommand } from "../../src/commands/deployment";
import { runCommand, stubFetch, type FetchStub } from "../helpers/harness";

let fetchStub: FetchStub;
afterEach(() => fetchStub?.restore());

describe("openship deployment get", () => {
  it("GETs /deployments/:id and renders it", async () => {
    fetchStub = stubFetch(() => ({
      json: { data: { ...deploymentFixture(), id: "dep1", status: "ready" } },
    }));
    const { out, code } = await runCommand(deploymentCommand, ["get", "dep1"]);
    expect(code).toBe(0);
    expect(fetchStub.calls[0].url).toBe("http://api.test/api/deployments/dep1");
    expect(out).toContain("dep1");
    expect(out).toContain("ready");
  });
});

describe("openship deployment redeploy", () => {
  it("POSTs to /deployments/:id/redeploy", async () => {
    fetchStub = stubFetch(() => ({ json: { success: true, deployment_id: "dep2", project_id: "project-a" } }));
    const { code } = await runCommand(deploymentCommand, ["redeploy", "dep1"]);
    expect(code).toBe(0);
    expect(fetchStub.calls[0].method).toBe("POST");
    expect(fetchStub.calls[0].url).toBe("http://api.test/api/deployments/dep1/redeploy");
  });
});

describe("openship deployment rollback", () => {
  it("POSTs to /deployments/:id/rollback", async () => {
    fetchStub = stubFetch(() => ({ json: { data: deploymentFixture() } }));
    const { code } = await runCommand(deploymentCommand, ["rollback", "dep1"]);
    expect(code).toBe(0);
    expect(fetchStub.calls[0].method).toBe("POST");
    expect(fetchStub.calls[0].url).toBe("http://api.test/api/deployments/dep1/rollback");
  });
});

describe("openship deployment cancel", () => {
  it("reports success only after the worker lease is released", async () => {
    fetchStub = stubFetch(() => ({
      json: { success: true, pending: false, status: "cancelled", message: "Deployment cancelled" },
    }));

    const { code, err } = await runCommand(deploymentCommand, ["cancel", "dep1"]);

    expect(code).toBe(0);
    expect(err).toContain("Cancelled dep1");
    expect(fetchStub.calls[0]).toMatchObject({
      method: "POST",
      url: "http://api.test/api/deployments/dep1/cancel",
    });
  });

  it("exits non-zero instead of claiming success while cancellation is pending", async () => {
    fetchStub = stubFetch(() => ({
      status: 202,
      json: {
        success: false,
        pending: true,
        status: "cancelling",
        message: "Cancellation was requested, but the deployment worker is still stopping.",
      },
    }));

    const { code, err } = await runCommand(deploymentCommand, ["cancel", "dep1"]);

    expect(code).toBe(1);
    expect(err).toContain("worker is still stopping");
    expect(err).not.toContain("Cancelled dep1");
  });
});
