// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPublicEndpoint, type PublicEndpoint } from "@/context/deployment/types";
import { RoutingModePicker } from "./RoutingModePicker";

vi.mock("@/context/PlatformContext", () => ({
  usePlatform: () => ({ selfHosted: true, baseDomain: "opsh.test" }),
}));
vi.mock("@/context/CloudContext", () => ({ useDefaultDomainType: () => "custom" }));
vi.mock("@/context/ModalContext", () => ({
  useModal: () => ({ showModal: vi.fn(), hideModal: vi.fn() }),
}));

let root: Root;
let container: HTMLDivElement;
let endpoints: PublicEndpoint[];
const changed = vi.fn();
function Harness({
  allowRedirects = true,
  hasServer = false,
}: {
  allowRedirects?: boolean;
  hasServer?: boolean;
}) {
  const [value, setValue] = useState(endpoints);
  endpoints = value;
  return (
    <RoutingModePicker
      mode="custom"
      onModeChange={() => {}}
      labels={{ noneLabel: "None", noneDesc: "Internal" }}
      projectName="site"
      endpoints={value}
      hasServer={hasServer}
      runtimePort=""
      allowRedirects={allowRedirects}
      onEndpointsChange={(next, port) => {
        changed(next, port);
        setValue(next);
      }}
    />
  );
}
const button = (selector: string) => {
  const found = document.querySelector<HTMLButtonElement>(selector);
  expect(found, selector).not.toBeNull();
  return found!;
};
const click = async (selector: string) => act(async () => button(selector).click());
async function select(value: string) {
  await click('[aria-label="Domain behavior"]');
  const option = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="option"]')).find(
    (e) => e.textContent?.includes(value),
  );
  expect(option, value).toBeDefined();
  await act(async () => option!.click());
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  endpoints = [
    createPublicEndpoint({ domainType: "custom", customDomain: "example.com", targetPath: "/" }),
  ];
  changed.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("adds a default redirect, displays its role and switches primary or serves both", async () => {
  await act(async () => root.render(<Harness />));
  await click('[role="switch"][aria-label="Include www"]');
  expect(changed).toHaveBeenCalledTimes(1);
  expect(endpoints[1]).toMatchObject({ redirectTo: "example.com", redirectStatus: 301 });
  expect(container.textContent).toContain("www.example.com → example.com");
  expect(container.textContent).toContain("Redirect domain");
  await select("www.example.com as primary");
  expect(endpoints[0]).toMatchObject({ customDomain: "www.example.com", redirectTo: "" });
  expect(endpoints[1].redirectTo).toBe("www.example.com");
  await select("Serve both");
  expect(endpoints.every((e) => !e.redirectTo && !e.redirectStatus)).toBe(true);
  expect(container.textContent).not.toContain("Redirect domain");
  expect(changed).toHaveBeenCalledTimes(3);
});

it("serves both without provider-specific copy when a caller disables redirect editing", async () => {
  await act(async () => root.render(<Harness allowRedirects={false} />));
  await click('[role="switch"][aria-label="Include www"]');
  expect(endpoints).toHaveLength(2);
  expect(endpoints.every((e) => !e.redirectTo)).toBe(true);
  expect(container.textContent).toContain("Both hostnames serve the app.");
  expect(container.querySelector('[aria-label="Domain behavior"]')).toBeNull();
});

it("retains www when it was chosen as primary and Include www is turned off", async () => {
  await act(async () => root.render(<Harness />));
  await click('[role="switch"][aria-label="Include www"]');
  await select("www.example.com as primary");
  await click('[role="switch"][aria-label="Include www"]');
  expect(endpoints).toHaveLength(1);
  expect(endpoints[0]).toMatchObject({ customDomain: "www.example.com", redirectTo: "" });
});

it("updates the runtime port to the selected serving hostname in the same change", async () => {
  endpoints = [
    createPublicEndpoint({ domainType: "custom", customDomain: "example.com", port: "3000" }),
    createPublicEndpoint({ domainType: "custom", customDomain: "www.example.com", port: "8080" }),
  ];
  await act(async () => root.render(<Harness hasServer />));
  await select("www.example.com as primary");
  expect(changed).toHaveBeenLastCalledWith(
    expect.arrayContaining([
      expect.objectContaining({
        customDomain: "www.example.com",
        port: "8080",
        redirectTo: "",
      }),
      expect.objectContaining({
        customDomain: "example.com",
        port: "3000",
        redirectTo: "www.example.com",
      }),
    ]),
    "8080",
  );
});
