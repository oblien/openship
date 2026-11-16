// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { baseDictionary } from "@/i18n";
import { INITIAL_STATE, type DeploymentContextType } from "@/context/deployment/types";
import { DeploymentRegistryAccessNotice } from "./DeploymentRegistryAccessNotice";

let deployment: Pick<DeploymentContextType, "state" | "deploymentStatus">;
vi.mock("@/context/DeploymentContext", () => ({ useDeployment: () => deployment }));
vi.mock("@/components/i18n-provider", () => ({ useI18n: () => ({ t: baseDictionary }) }));
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  deployment = {
    state: {
      ...structuredClone(INITIAL_STATE),
      deploymentFailed: true,
      errorCode: "REGISTRY_ACCESS_DENIED",
      errorDetails: { registry: "ghcr.io", imageRef: "ghcr.io/org/private:main" },
    },
    deploymentStatus: "failed",
  };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () => root.render(<DeploymentRegistryAccessNotice />));
}

it("names the failed image, explains GHCR access, and opens the existing registry settings", async () => {
  await render();
  expect(host.textContent).toContain("ghcr.io/org/private:main");
  expect(host.textContent).toContain("read:packages");
  expect(host.textContent).toContain("Refresh images & redeploy");
  expect(host.querySelector('a[href="/settings?tab=connections#docker-registry"]')).not.toBeNull();
  expect(host.querySelectorAll("button")).toHaveLength(0);
});

it("renders untrusted metadata as text and never derives a link from it", async () => {
  deployment.state.errorDetails = { registry: 'javascript:alert(1)', imageRef: '<img src=x onerror="alert(1)">' };
  await render();
  expect(host.textContent).toContain('<img src=x onerror="alert(1)">');
  expect(host.querySelector("img")).toBeNull();
  expect(host.textContent).not.toContain("read:packages");
  expect(host.querySelector('a')?.getAttribute("href")).toBe("/settings?tab=connections#docker-registry");
});

it.each(["building", "verifying", "ready", "cancelled"] as const)("clears recovery after %s", async status => {
  deployment.deploymentStatus = status;
  await render();
  expect(host.textContent).toBe("");
});

it("does not turn another failure or cancellation into a registry-access problem", async () => {
  deployment.state.errorCode = "HOST_UNREACHABLE";
  await render();
  expect(host.textContent).toBe("");
  deployment.state.errorCode = "REGISTRY_ACCESS_DENIED";
  deployment.state.deploymentCanceled = true;
  await render();
  expect(host.textContent).toBe("");
});
