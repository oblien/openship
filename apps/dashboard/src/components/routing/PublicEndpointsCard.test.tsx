// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPublicEndpoint } from "@/context/deployment/types";
import PublicEndpointsCard from "./PublicEndpointsCard";

vi.mock("@/context/PlatformContext", () => ({
  usePlatform: () => ({ selfHosted: true, baseDomain: "opsh.test" }),
}));
vi.mock("@/context/CloudContext", () => ({ useDefaultDomainType: () => "free" }));
vi.mock("@/context/ModalContext", () => ({
  useModal: () => ({ showModal: vi.fn(), hideModal: vi.fn() }),
}));

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

it.each([true, false])(
  "preserves imported proxy paths only when requested (%s)",
  async (preserveProxyPaths) => {
    const endpoint = createPublicEndpoint({
      domainType: "custom",
      customDomain: "api.example.com",
      port: "3000",
      targetPath: "/v1",
      exact: true,
    });
    const onChange = vi.fn();
    await act(async () =>
      root.render(
        <PublicEndpointsCard
          projectName="api"
          endpoints={[endpoint]}
          hasServer
          runtimePort="3000"
          hideHeader
          hideTypeToggle
          portInline
          preserveProxyPaths={preserveProxyPaths}
          onChange={onChange}
        />,
      ),
    );
    const port =
      container.querySelector<HTMLInputElement>('input[aria-label="Port"]') ??
      Array.from(container.querySelectorAll("input")).find((input) => input.value === "3000");
    expect(port).toBeDefined();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(port, "8080");
      port!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          customDomain: "api.example.com",
          port: "8080",
          targetPath: preserveProxyPaths ? "/v1" : "",
          exact: true,
        }),
      ],
      "8080",
    );
  },
);

it("adds domains with the caller's selected type when its internal type switch is hidden", async () => {
  const onChange = vi.fn();
  await act(async () =>
    root.render(
      <PublicEndpointsCard
        projectName="api"
        endpoints={[
          createPublicEndpoint({
            domainType: "custom",
            customDomain: "api.example.com",
            port: "3000",
          }),
        ]}
        hasServer
        runtimePort="3000"
        hideHeader
        hideTypeToggle
        onChange={onChange}
      />,
    ),
  );
  const add =
    container.querySelector<HTMLButtonElement>('[aria-label="Add domain"]') ??
    Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Add domain",
    );
  expect(add).toBeDefined();
  await act(async () => add!.click());
  expect(onChange).toHaveBeenCalledWith(
    [
      expect.objectContaining({ domainType: "custom", customDomain: "api.example.com" }),
      expect.objectContaining({ domainType: "custom", port: "3000" }),
    ],
    "3000",
  );
});
