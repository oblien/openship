// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InternalServiceNotice } from "./ComposeServices";

vi.mock("@/context/DeploymentContext", () => ({ useDeployment: () => ({}) }));
vi.mock("@/context/PlatformContext", () => ({ usePlatform: () => ({ baseDomain: "opsh.test" }) }));
vi.mock("@/hooks/use-service-env-reveal", () => ({ useServiceEnvReveal: () => ({}) }));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(exposedPorts: string[]): Promise<string> {
  await act(async () => {
    root.render(<InternalServiceNotice exposedPorts={exposedPorts} />);
  });
  return container.textContent ?? "";
}

describe("InternalServiceNotice", () => {
  it("names the container ports a service exposes and says how to publish one", async () => {
    const text = await render(["3000", "8080/udp"]);
    expect(text).toContain("3000, 8080/udp");
    expect(text).toContain("127.0.0.1:3000:3000");
  });

  it("keeps the plain no-public-ports copy when the file declares no exposed ports", async () => {
    const text = await render([]);
    expect(text).toContain("No public ports detected");
    expect(text).not.toContain("127.0.0.1:");
  });
});
