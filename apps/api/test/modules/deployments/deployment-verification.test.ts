import { beforeEach, expect, it, vi } from "vitest";
import { BuildLogger } from "@repo/adapters";
import { beginDeploymentVerification } from "@repo/platform/engine/modules/deployments/deployment-verification";

const { record } = vi.hoisted(() => ({ record: vi.fn() }));
vi.mock("@repo/db", () => ({ repos: { deployment: { setVerification: record } } }));
const dep = { id: "attempt", organizationId: "tenant" };
beforeEach(() => record.mockReset().mockResolvedValue(true));

it("publishes only HTTP destinations and scopes progress to the deployment's tenant", async () => {
  const events = vi.fn();
  await beginDeploymentVerification(dep, new BuildLogger(events), [
    "https://app.test", "https://app.test", "http://app.test:8080/", "javascript:alert(1)",
    "https://user:password@app.test", "https://*.app.test", "invalid",
  ]);
  const verification = record.mock.calls[0][2];
  expect(record).toHaveBeenCalledWith("attempt", "tenant", verification);
  expect(verification.urls).toEqual(["https://app.test", "http://app.test:8080/"]);
  expect(events).toHaveBeenCalledWith(expect.objectContaining({ step: "verify", stepStatus: "running", verification }));
});

it("does not turn an observability write outage into a failed live deployment", async () => {
  record.mockRejectedValueOnce(new Error("Database disconnected"));
  const events = vi.fn();
  await expect(beginDeploymentVerification(dep, new BuildLogger(events), [])).resolves.toBeUndefined();
  expect(events).toHaveBeenCalledWith(expect.objectContaining({ step: "verify" }));
});

it("does not resurrect a cancelled or settled deployment", async () => {
  record.mockResolvedValueOnce(false);
  const events = vi.fn();
  await expect(beginDeploymentVerification(dep, new BuildLogger(events), ["https://app.test"]))
    .rejects.toThrow("Deployment changed before startup verification");
  expect(events).not.toHaveBeenCalled();
});
