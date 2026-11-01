import { afterEach, describe, expect, it, vi } from "vitest";
import { deploymentFixture } from "../../../../packages/contracts/test/fixtures";

vi.mock("../../src/lib/config", () => ({
  getApiUrl: () => "http://api.test",
  getToken: () => "tok",
}));

import { deploymentCommand } from "../../src/commands/deployment";
import { runCommand, stubFetch, type FetchStub } from "../helpers/harness";
import { setJsonMode } from "../../src/lib/output";

let fetchStub: FetchStub;
afterEach(() => { fetchStub?.restore(); setJsonMode(false); });

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
  it("forwards explicit deployment-only retry through the shared SDK contract", async () => {
    fetchStub = stubFetch(() => ({ json: { success: true, deployment_id: "dep2", project_id: "project-a" } }));
    const { code } = await runCommand(deploymentCommand, ["redeploy", "dep1", "--reuse-build"]);
    expect(code).toBe(0);
    expect(fetchStub.calls[0].body).toMatchObject({ reuseBuild: true, useExistingCommit: false });
  });
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

describe("deployment automation", () => {
  it("refuses deletion without --yes in JSON mode", async () => {
    setJsonMode(true);
    fetchStub = stubFetch(() => { throw new Error("Must not delete without confirmation"); });
    const result = await runCommand(deploymentCommand, ["rm", "dep1"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("--yes");
    expect(fetchStub.calls).toEqual([]);
  });

  it.each(["ready", "failed", "action_required"])("returns the persisted %s outcome in JSON with an accurate exit", async status => {
    setJsonMode(true);
    fetchStub = stubFetch(() => ({ json: {
      success: true, deployment_id: "dep1", project_id: "project-a", status, deploymentStatus: status,
      is_active: false, cancellationPending: false, decisionPending: status === "action_required",
      pendingPrompt: status === "action_required" ? { promptId: "p", title: "Choose", message: "Choose an action", actions: [{ id: "abort", label: "Abort" }] } : null,
    } }));
    const result = await runCommand(deploymentCommand, ["wait", "dep1", "--timeout", "1000"]);
    expect(result.code).toBe(status === "ready" ? 0 : 1);
    expect(JSON.parse(result.out)).toMatchObject({ status, success: status === "ready" });
    expect(fetchStub.calls.every(req => req.method === "GET")).toBe(true);
  });
});
