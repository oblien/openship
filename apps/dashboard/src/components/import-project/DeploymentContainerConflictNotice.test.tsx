// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { baseDictionary } from "@/i18n";
import {
  DEFAULT_CONFIG,
  INITIAL_STATE,
  type DeploymentContextType,
} from "@/context/deployment/types";
import { DeploymentContainerConflictNotice } from "./DeploymentContainerConflictNotice";

let deployment: Pick<DeploymentContextType, "config" | "state" | "deploymentStatus">;
vi.mock("@/context/DeploymentContext", () => ({ useDeployment: () => deployment }));
vi.mock("@/components/i18n-provider", () => ({ useI18n: () => ({ t: baseDictionary }) }));
let root: Root;
let host: HTMLDivElement;
const copy = baseDictionary.deployments.containerConflict;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  deployment = {
    config: {
      ...structuredClone(DEFAULT_CONFIG),
      serverId: "server-current",
      workspaceId: "space-current",
    },
    state: {
      ...structuredClone(INITIAL_STATE),
      deploymentId: "attempt-original",
      deploymentFailed: true,
      errorCode: "SERVICE_CONTAINER_CONFLICT",
      errorDetails: {
        containerNames: ['<img src=x onerror="alert(1)">', "app-duplicate"],
        serverId: "server-original",
      },
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
  await act(async () => root.render(<DeploymentContainerConflictNotice />));
}

it("explains the conflict and links to the recorded server and support, without destructive actions", async () => {
  await render();
  expect(host.textContent).toContain(copy.title);
  expect(host.textContent).toContain("app-duplicate");
  expect(host.textContent).toContain("attempt-original");
  expect(host.querySelector('a[href="/servers/server-original"]')).not.toBeNull();
  expect(host.querySelector('a[href="/support"]')).not.toBeNull();
  expect(host.querySelectorAll("button")).toHaveLength(0);
  expect(host.querySelector("img")).toBeNull();
});
it("opens the recorded managed space when no standalone server was recorded", async () => {
  deployment.state.errorDetails = { containerNames: ["a", "b"], workspaceId: "space-original" };
  await render();
  expect(host.querySelector('a[href="/resources?pool=space-original"]')).not.toBeNull();
});
it("does not guess a missing historical target from current configuration", async () => {
  deployment.state.errorDetails = null;
  await render();
  expect(host.querySelectorAll("a")).toHaveLength(1);
  expect(host.querySelector('a[href="/support"]')).not.toBeNull();
});
it.each(["building", "verifying", "ready", "cancelled"] as const)(
  "clears the notice for %s",
  async (status) => {
    deployment.deploymentStatus = status;
    await render();
    expect(host.textContent).toBe("");
  },
);
it("does not reinterpret another error or a cancelled attempt as a container conflict", async () => {
  deployment.state.errorCode = "HOST_UNREACHABLE";
  await render();
  expect(host.textContent).toBe("");
  deployment.state.errorCode = "SERVICE_CONTAINER_CONFLICT";
  deployment.state.deploymentCanceled = true;
  await render();
  expect(host.textContent).toBe("");
});
