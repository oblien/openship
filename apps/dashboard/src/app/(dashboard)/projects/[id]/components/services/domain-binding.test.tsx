// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
import { ModalProvider } from "@/context/ModalContext";
import { baseDictionary } from "@/i18n";
import type { Service } from "@/lib/api/services";
import { DomainSettings } from "../DomainSettings";

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  create: vi.fn(),
  patch: vi.fn(),
  list: vi.fn(),
  listPage: vi.fn(),
  refreshServices: vi.fn(),
  toast: vi.fn(),
  changed: vi.fn(),
  cloud: vi.fn(),
}));
let context: ReturnType<typeof import("@/context/ProjectSettingsContext").useProjectSettings>;
vi.mock("@/context/ProjectSettingsContext", () => ({ useProjectSettings: () => context }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ showToast: mocks.toast }) }));
vi.mock("@/context/PlatformContext", () => ({
  usePlatform: () => ({ baseDomain: "opsh.test", selfHosted: true }),
}));
vi.mock("@/context/CloudContext", () => ({
  useCloud: () => ({ connected: true, requireCloud: mocks.cloud }),
  useDefaultDomainType: () => "custom",
}));
vi.mock("@/hooks/useSystemPrepareModal", () => ({
  useEdgeModal: () => vi.fn(),
  useVerifyModal: () => vi.fn(),
  useRoutingRetryModal: () => vi.fn(),
}));
vi.mock("@/hooks/useProjectEndpoints", () => ({ invalidateProjectCaches: vi.fn() }));
vi.mock("@/hooks/useLocalhostForward", () => ({
  useLocalhostForward: () => ({ canForward: false }),
}));
vi.mock("../RoutingUnsyncedCallout", () => ({ RoutingUnsyncedCallout: () => null }));
vi.mock("../RoutingConfigCard", () => ({ RoutingConfigCard: () => null }));
vi.mock("../RouteRules", () => ({ RouteRules: () => null }));
vi.mock("@/lib/api", async (original) => {
  const actual = await original<typeof import("@/lib/api")>();
  return {
    ...actual,
    servicesApi: { ...actual.servicesApi, update: mocks.update },
    projectsApi: { ...actual.projectsApi, getEdgeStatus: async () => ({ ready: true }) },
    deployApi: {
      ...actual.deployApi,
      checkPorts: async () => ({ data: [] }),
      checkOutput: async () => ({ data: [] }),
    },
    domainsApi: {
      ...actual.domainsApi,
      list: mocks.list,
      listPage: mocks.listPage,
      create: mocks.create,
      update: mocks.patch,
      dnsChallenge: async () => ({ data: null }),
      previewRecords: async () => ({ data: { mode: "cloud", records: [] } }),
    },
  };
});

const web: Service = {
  id: "svc-web",
  name: "web",
  kind: "compose",
  enabled: true,
  image: "example/web",
  build: null,
  ports: ["3000", "9000"],
  volumes: [],
  dockerfile: null,
  buildArgs: null,
  dependsOn: [],
  environment: null,
  command: null,
  restart: null,
  exposed: true,
  exposedPort: "3000",
  domain: null,
  customDomain: "app.example.com",
  domainType: "custom",
  publicEndpoints: [{ port: 3000, domainType: "custom", customDomain: "app.example.com" }],
  sortOrder: 0,
};
const api: Service = {
  ...web,
  id: "svc-api",
  name: "api",
  ports: ["4000"],
  exposedPort: "4000",
  customDomain: null,
  publicEndpoints: [],
};
const copy = baseDictionary.projectDetail.services.detail.networking;
const domains = baseDictionary.projectSettings.domains;
const row = (id: string, hostname: string, fields: Record<string, unknown>) => ({
  id,
  hostname,
  ownerType: "project",
  projectId: "project-stack",
  domainType: "custom",
  verified: true,
  status: "active",
  sslStatus: "active",
  isPrimary: false,
  boundByDomain: false,
  serviceId: null,
  targetPort: null,
  ...fields,
});
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const rows = [
    row("dom-app", "app.example.com", { serviceId: web.id, targetPort: 3000 }),
    row("dom-tenant", "tenant.example.org", {
      serviceId: web.id,
      targetPort: 9000,
      boundByDomain: true,
    }),
    row("dom-parked", "parked.example.org", { boundByDomain: true }),
  ];
  context = {
    id: "project-stack",
    projectData: {
      id: "project-stack",
      name: "stack",
      slug: "stack",
      framework: "services",
      description: "",
      deployTarget: "cloud",
      activeDeploymentId: "dep-active",
      serviceCount: 2,
      domains: rows,
      options: { hasServer: true },
    },
    domainsData: { domains: rows, isLoading: false, error: null },
    servicesData: { services: [web, api], isLoading: false, error: null },
    buildData: { hasServer: true, productionPort: "3000" },
    access: { kind: "none", url: null, host: null, isLocal: false, urls: [] },
    refreshServices: mocks.refreshServices,
    updateDomains: (next: Parameters<typeof context.updateDomains>[0]) => {
      context.domainsData.domains = next;
    },
    setProjectData: vi.fn(),
    setPendingDomainAction: vi.fn(),
    pendingDomainAction: null,
  } as unknown as typeof context;
  mocks.cloud.mockResolvedValue(true);
  mocks.list.mockImplementation(async () => ({ data: context.domainsData.domains }));
  mocks.listPage.mockResolvedValue({ data: rows.filter((item) => item.boundByDomain) });
  mocks.patch.mockImplementation(async (id: string) => ({
    data: rows.find((item) => item.id === id),
  }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const settle = (ms = 0) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
async function render(scope?: { serviceId: string; add?: boolean }) {
  await act(async () =>
    root.render(
      <I18nProvider>
        <ModalProvider>
          <DomainSettings serviceScope={scope} onRoutesChanged={mocks.changed} />
        </ModalProvider>
      </I18nProvider>,
    ),
  );
  await settle();
}
function button(label: string) {
  const match = [...document.querySelectorAll("button")].find(
    (element) =>
      element.getAttribute("aria-label") === label || element.textContent?.trim() === label,
  );
  expect(match, `button ${label}`).toBeDefined();
  return match!;
}
async function click(label: string) {
  await act(async () => button(label).click());
}
async function type(label: string, value: string) {
  const element = [...host.querySelectorAll("input")].find(
    (item) => item.getAttribute("aria-label") === label,
  )!;
  expect(element, `input ${label}`).toBeDefined();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function card(hostname: string) {
  return [...host.querySelectorAll("div.rounded-2xl")].find(
    (element) => element.querySelector("h3")?.textContent === hostname,
  )!;
}

describe("row-owned domain bindings", () => {
  it("shows each card's target port, bound service and whether its row or the service list routes it", async () => {
    await render();
    expect(mocks.listPage).toHaveBeenCalledWith(
      "project-stack",
      expect.objectContaining({ bound: true, limit: 50 }),
    );
    const tenant = card("tenant.example.org").textContent;
    expect(tenant).toContain("web · port 9000");
    expect(tenant).toContain(`${domains.overview.routedBy}${domains.binding.routedByDomain}`);
    expect(card("parked.example.org").textContent).toContain(domains.binding.notRouted);
    expect(host.textContent).toContain(
      `${domains.overview.routedBy}${domains.binding.routedByService}`,
    );
  });

  it("creates a custom domain bound by its own row instead of appending to the service's endpoints", async () => {
    mocks.create.mockResolvedValue({
      data: row("dom-new", "shop.example.org", {
        serviceId: web.id,
        targetPort: 9000,
        boundByDomain: true,
      }),
    });
    await render({ serviceId: web.id, add: true });
    await click(domains.addRoute.custom);
    await type(domains.add.domainName, "Shop.Example.org");
    await type(copy.containerPort, "9000");
    await act(async () =>
      host
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(mocks.create).toHaveBeenCalledExactlyOnceWith("project-stack", {
      hostname: "shop.example.org",
      serviceId: web.id,
      targetPort: 9000,
    });
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.list).toHaveBeenCalled();
    expect(mocks.changed).toHaveBeenCalledOnce();
  });

  it("moves, unbinds and binds a row with PATCH /domains/:id", async () => {
    await render();
    await click(`${copy.manage} tenant.example.org`);
    await click(domains.binding.move);
    await click(domains.binding.service);
    const option = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
      (element) => element.textContent?.startsWith("api"),
    );
    await act(async () => option!.click());
    await click(domains.binding.save);
    expect(mocks.patch).toHaveBeenLastCalledWith("dom-tenant", {
      serviceId: api.id,
      targetPort: 4000,
    });

    await click(`${copy.manage} tenant.example.org`);
    await click(domains.binding.unbind);
    await click(domains.binding.unbind);
    expect(mocks.patch).toHaveBeenLastCalledWith("dom-tenant", { serviceId: null });

    await click(`${copy.manage} parked.example.org`);
    await click(domains.binding.bind);
    await click(domains.binding.port);
    await act(async () =>
      [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((element) => element.textContent?.startsWith("Port 9000"))!.click(),
    );
    await click(domains.binding.save);
    expect(mocks.patch).toHaveBeenLastCalledWith("dom-parked", {
      serviceId: web.id,
      targetPort: 9000,
    });
    expect(mocks.patch).toHaveBeenCalledTimes(3);
  });

  it("offers no binding change for a domain routed by the service's endpoint list", async () => {
    await render();
    await click(`${copy.manage} app.example.com`);
    const labels = [...document.querySelectorAll("button")].map((element) =>
      element.textContent?.trim(),
    );
    expect(labels).not.toContain(domains.binding.move);
    expect(labels).not.toContain(domains.binding.bind);
  });

  it("searches row-bound domains on the server and loads the next page from its cursor", async () => {
    const extra = row("dom-extra", "zz-tenant.example.org", {
      serviceId: web.id,
      targetPort: 3000,
      boundByDomain: true,
    });
    context.domainsData.domains = [...context.domainsData.domains, extra];
    mocks.listPage.mockResolvedValueOnce({
      data: [context.domainsData.domains[1]],
      nextCursor: "next-1",
    });
    mocks.listPage.mockResolvedValueOnce({ data: [extra] });
    await render();
    expect(host.textContent).not.toContain("zz-tenant.example.org");
    await click(domains.binding.loadMore);
    await settle();
    expect(mocks.listPage).toHaveBeenLastCalledWith(
      "project-stack",
      expect.objectContaining({ bound: true, cursor: "next-1" }),
    );
    expect(host.textContent).toContain("zz-tenant.example.org");
    expect(host.textContent).toContain("tenant.example.org");

    mocks.listPage.mockResolvedValueOnce({ data: [] });
    await type(domains.binding.search, "nothing");
    await settle(350);
    expect(mocks.listPage).toHaveBeenLastCalledWith(
      "project-stack",
      expect.objectContaining({ bound: true, q: "nothing" }),
    );
    expect(mocks.listPage.mock.lastCall![1].cursor).toBeUndefined();
    expect(host.textContent).toContain(domains.binding.noMatches.replace("{query}", "nothing"));
  });
});
