// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPublicEndpoint } from "@/context/deployment/types";
import BuildSettings from "./BuildSettings";

const mocks = vi.hoisted(() => ({ config: {} as any, updateConfig: vi.fn() }));
vi.mock("@/context/PlatformContext", () => ({ usePlatform: () => ({ baseDomain: "opsh.test" }) }));
vi.mock("@/context/DeploymentContext", () => ({
  useOptionalDeployment: () => ({
    config: mocks.config,
    updateConfig: mocks.updateConfig,
    updateOptions: vi.fn(),
  }),
}));
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.updateConfig.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it.each([false, true])(
  "only exposes app target fields for serving domains (server=%s)",
  async (hasServer) => {
    const redirect = createPublicEndpoint({
      domainType: "custom",
      customDomain: "example.com",
      redirectTo: "www.example.com",
      redirectStatus: 301,
      port: "3000",
      targetPath: "/",
    });
    const serving = createPublicEndpoint({
      domainType: "custom",
      customDomain: "www.example.com",
      port: "3000",
      targetPath: "/",
    });
    mocks.config = {
      framework: "vite",
      publicEndpoints: [redirect, serving],
      options: { hasBuild: true, hasServer, productionPort: "3000" },
    };
    await act(async () => root.render(<BuildSettings />));
    const labels = Array.from(container.querySelectorAll("label")).filter((label) =>
      /(?:Path|Port) for/.test(label.textContent ?? ""),
    );
    expect(labels).toHaveLength(1);
    expect(labels[0].textContent).toContain("www.example.com");
    if (hasServer) {
      const input = document.getElementById(labels[0].htmlFor) as HTMLInputElement;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          input,
          "8080",
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(mocks.updateConfig).toHaveBeenCalledWith(
        expect.objectContaining({ publicEndpoints: [redirect, { ...serving, port: "8080" }] }),
      );
    }
    mocks.config.publicEndpoints = [
      { ...redirect, redirectTo: undefined, redirectStatus: undefined },
      serving,
    ];
    await act(async () => root.render(<BuildSettings key="both" />));
    expect(
      Array.from(container.querySelectorAll("label")).filter((label) =>
        /(?:Path|Port) for/.test(label.textContent ?? ""),
      ),
    ).toHaveLength(2);
  },
);
