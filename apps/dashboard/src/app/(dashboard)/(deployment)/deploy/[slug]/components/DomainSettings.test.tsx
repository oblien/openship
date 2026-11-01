// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPublicEndpoint } from "@/context/deployment/types";
import DomainSettings from "./DomainSettings";

const mocks = vi.hoisted(() => ({
  selfHosted: true,
  scopeVersion: 0,
  picker: vi.fn(),
  update: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("@/context/PlatformContext", () => ({
  usePlatform: () => ({ selfHosted: mocks.selfHosted }),
}));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ showToast: mocks.toast }) }));
vi.mock("@/lib/api", () => ({
  projectsApi: { update: mocks.update },
  getApiErrorMessage: vi.fn(),
}));
vi.mock("@/components/routing/RoutingModePicker", () => ({
  RoutingModePicker: (props: unknown) => {
    mocks.picker(props);
    return null;
  },
}));
vi.mock("@/lib/api/client", async (original) => ({
  ...(await original<typeof import("@/lib/api/client")>()),
  getApiRequestScopeVersion: () => mocks.scopeVersion,
}));
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.scopeVersion = 0;
  mocks.picker.mockReset();
  mocks.update.mockReset().mockResolvedValue({});
  mocks.toast.mockReset();
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
  "offers redirect choices in both hosted and self-hosted shells (selfHosted=%s)",
  async (selfHosted) => {
    mocks.selfHosted = selfHosted;
    await act(async () =>
      root.render(
        <DomainSettings
          projectName="site"
          endpoints={[
            createPublicEndpoint({
              domainType: "custom",
              customDomain: "example.com",
              targetPath: "/",
            }),
          ]}
          hasServer={false}
          runtimePort=""
          setEndpoints={() => {}}
          noPublicRoute={false}
          setNoPublicRoute={() => {}}
        />,
      ),
    );
    expect(mocks.picker).toHaveBeenLastCalledWith(
      expect.objectContaining({ allowRedirects: true }),
    );
  },
);

it("preserves autosave order through failure, a primary switch and None", async () => {
  const projectId = "ordered-wizard-saves";
  await act(async () =>
    root.render(
      <DomainSettings
        projectId={projectId}
        projectName="site"
        endpoints={[]}
        hasServer
        runtimePort="3000"
        setEndpoints={() => {}}
        noPublicRoute={false}
        setNoPublicRoute={() => {}}
      />,
    ),
  );
  const props = mocks.picker.mock.lastCall![0];
  let failFirst!: (error: Error) => void;
  mocks.update.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        failFirst = reject;
      }),
  );
  let finishSecond!: () => void;
  mocks.update.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishSecond = resolve;
      }),
  );
  const first = props.onEndpointsChange([
    createPublicEndpoint({ domainType: "custom", customDomain: "example.com", port: "3000" }),
    createPublicEndpoint({
      domainType: "custom",
      customDomain: "www.example.com",
      port: "3000",
      redirectTo: "example.com",
      redirectStatus: 301,
    }),
  ]);
  await act(async () => {
    await Promise.resolve();
  });
  expect(mocks.update).toHaveBeenCalledTimes(1);
  const second = props.onEndpointsChange([
    createPublicEndpoint({ domainType: "custom", customDomain: "www.example.com", port: "8080" }),
    createPublicEndpoint({
      domainType: "custom",
      customDomain: "example.com",
      port: "3000",
      redirectTo: "www.example.com",
      redirectStatus: 301,
    }),
  ]);
  props.onModeChange("none");
  await act(async () => {
    await Promise.resolve();
  });
  expect(mocks.update).toHaveBeenCalledTimes(1);
  await act(async () => {
    failFirst(new Error("save failed"));
    await first;
  });
  expect(mocks.update).toHaveBeenCalledTimes(2);
  expect(mocks.update).toHaveBeenLastCalledWith(
    projectId,
    expect.objectContaining({
      port: 8080,
      publicEndpoints: [
        expect.objectContaining({ customDomain: "www.example.com", port: 8080 }),
        expect.objectContaining({ redirectTo: "www.example.com", redirectStatus: 301 }),
      ],
    }),
  );
  await act(async () => {
    finishSecond();
    await second;
  });
  expect(mocks.update).toHaveBeenCalledTimes(3);
  expect(mocks.update).toHaveBeenLastCalledWith(projectId, { publicEndpoints: [] });
  expect(mocks.toast).toHaveBeenCalledTimes(1);
});

it("discards queued saves after an account switch without blocking the new scope", async () => {
  const projectId = "scope-owned-routing";
  await act(async () =>
    root.render(
      <DomainSettings
        projectId={projectId}
        projectName="site"
        endpoints={[]}
        hasServer={false}
        runtimePort=""
        setEndpoints={() => {}}
        noPublicRoute={false}
        setNoPublicRoute={() => {}}
      />,
    ),
  );
  const props = mocks.picker.mock.lastCall![0];
  const endpoints = [
    createPublicEndpoint({ domainType: "custom", customDomain: "example.com", targetPath: "/" }),
  ];
  let finishFirst!: () => void;
  mocks.update.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishFirst = resolve;
      }),
  );
  const first = props.onEndpointsChange(endpoints);
  await act(async () => {
    await Promise.resolve();
  });
  const stale = props.onEndpointsChange(endpoints);
  mocks.scopeVersion++;
  await act(async () => {
    await props.onEndpointsChange(endpoints);
  });
  expect(mocks.update).toHaveBeenCalledTimes(2);
  await act(async () => {
    finishFirst();
    await Promise.all([first, stale]);
  });
  expect(mocks.update).toHaveBeenCalledTimes(2);
});
