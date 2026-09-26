// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
import { ModalProvider } from "@/context/ModalContext";
import { baseDictionary } from "@/i18n";
import type { Service, ServiceInput } from "@/lib/api/services";
import { DomainSettings } from "../DomainSettings";

const mocks = vi.hoisted(() => ({
  get: vi.fn(), update: vi.fn(), remove: vi.fn(), verify: vi.fn(), records: vi.fn(),
  refreshServices: vi.fn(), invalidate: vi.fn(), toast: vi.fn(), changed: vi.fn(),
  updateProject: vi.fn(), edge: vi.fn(), verifyModal: vi.fn(), cloud: vi.fn(),
  connect: vi.fn(), listDomains: vi.fn(), dnsChallenge: vi.fn(), startDnsChallenge: vi.fn(), dnsPlan: vi.fn(),
}));
let context: ReturnType<typeof import("@/context/ProjectSettingsContext").useProjectSettings>;
vi.mock("@/context/ProjectSettingsContext", () => ({ useProjectSettings: () => context }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ showToast: mocks.toast }) }));
vi.mock("@/context/PlatformContext", () => ({ usePlatform: () => ({ baseDomain: "opsh.test", selfHosted: true }) }));
vi.mock("@/context/CloudContext", () => ({ useCloud: () => ({ connected: true, requireCloud: mocks.cloud }), useDefaultDomainType: () => "custom" }));
vi.mock("@/hooks/useSystemPrepareModal", () => ({ useEdgeModal: () => mocks.edge, useVerifyModal: () => mocks.verifyModal, useRoutingRetryModal: () => vi.fn() }));
vi.mock("@/hooks/useProjectEndpoints", () => ({ invalidateProjectCaches: mocks.invalidate }));
vi.mock("@/hooks/useLocalhostForward", () => ({ useLocalhostForward: () => ({ canForward: false }) }));
vi.mock("../RoutingUnsyncedCallout", () => ({ RoutingUnsyncedCallout: () => null }));
vi.mock("../RoutingConfigCard", () => ({ RoutingConfigCard: () => null }));
vi.mock("../RouteRules", () => ({ RouteRules: () => null }));
vi.mock("@/lib/api", async (original) => {
  const actual = await original<typeof import("@/lib/api")>();
  return {
    ...actual,
    servicesApi: { ...actual.servicesApi, get: mocks.get, update: mocks.update },
    projectsApi: { ...actual.projectsApi, update: mocks.updateProject, connectDomain: mocks.connect, getEdgeStatus: async () => ({ ready: true }) },
    deployApi: { ...actual.deployApi, checkPorts: async () => ({ data: [] }), checkOutput: async () => ({ data: [] }) },
    domainsApi: { ...actual.domainsApi, remove: mocks.remove, verify: mocks.verify, records: mocks.records,
      list: mocks.listDomains, dnsChallenge: mocks.dnsChallenge, startDnsChallenge: mocks.startDnsChallenge, dnsPlan: mocks.dnsPlan,
      previewRecords: async () => ({ data: { mode: "cloud", records: [] } }) },
  };
});

const primary = { port: 3000, domainType: "custom" as const, customDomain: "app.example.com" };
const secondary = { port: 9000, domainType: "custom" as const, customDomain: "metrics.example.com" };
const service: Service = {
  id: "svc-app", name: "app", kind: "compose", enabled: true,
  image: "example/app", build: null, ports: ["127.0.0.1:8080:3000", "9000"], volumes: [],
  dockerfile: null, buildArgs: null, dependsOn: [], environment: null, command: null, restart: null,
  exposed: true, exposedPort: "3000", domain: null, customDomain: primary.customDomain,
  domainType: "custom", publicEndpoints: [primary, secondary], sortOrder: 0,
};
const other = { ...service, id: "svc-other", name: "other", customDomain: "other.example.com",
  publicEndpoints: [{ ...primary, customDomain: "other.example.com" }] };
const copy = baseDictionary.projectDetail.services.detail.networking;
const domains = baseDictionary.projectSettings.domains;
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const rows = [
    { id: "dom-app", hostname: primary.customDomain, serviceId: service.id, port: 3000 },
    { id: "dom-metrics", hostname: secondary.customDomain, serviceId: service.id, port: 9000 },
    { id: "dom-other", hostname: "other.example.com", serviceId: other.id, port: 3000 },
  ].map((row) => ({ ...row, verified: true, status: "active", sslStatus: "active", domainType: "custom" }));
  context = {
    id: "project-stack",
    projectData: { id: "project-stack", name: "stack", slug: "stack", framework: "services", description: "",
      deployTarget: "cloud", activeDeploymentId: "dep-active", serviceCount: 2, domains: rows, options: { hasServer: true } },
    domainsData: { domains: rows, isLoading: false, error: null },
    servicesData: { services: structuredClone([other, service]), isLoading: false, error: null },
    buildData: { hasServer: true, productionPort: "3000" },
    access: { kind: "none", url: null, host: null, isLocal: false, urls: [] },
    refreshServices: mocks.refreshServices,
    updateDomains: (next: Parameters<typeof context.updateDomains>[0]) => { context.domainsData.domains = next; },
    setProjectData: vi.fn(), setPendingDomainAction: vi.fn(), pendingDomainAction: null,
  } as unknown as typeof context;
  mocks.get.mockImplementation(async (_projectId: string, id: string) => ({
    success: true, service: structuredClone(context.servicesData.services.find((item) => item.id === id)),
  }));
  mocks.update.mockImplementation(async (_projectId: string, id: string, patch: Partial<ServiceInput>) => {
    context.servicesData.services = context.servicesData.services.map((item) => item.id === id ? { ...item, ...patch } as Service : item);
    return { success: true };
  });
  mocks.refreshServices.mockImplementation(async () => context.servicesData.services);
  mocks.cloud.mockResolvedValue(true);
  mocks.remove.mockResolvedValue({ success: true });
  mocks.verify.mockResolvedValue({ verified: true, sslStatus: "active" });
  mocks.records.mockResolvedValue({ data: { mode: "cloud", records: [] } });
  mocks.dnsChallenge.mockResolvedValue({ data: null });
  mocks.dnsPlan.mockResolvedValue({ data: { status: "none", records: [] } });
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
async function render(scope: { serviceId: string; port?: number; add?: boolean } | null = { serviceId: service.id }) {
  await act(async () => root.render(<I18nProvider><ModalProvider>
    <DomainSettings serviceScope={scope ?? undefined} onRoutesChanged={mocks.changed} />
  </ModalProvider></I18nProvider>));
}
function button(label: string) {
  const match = [...document.querySelectorAll("button")].find((element) => element.getAttribute("aria-label") === label || element.textContent?.trim() === label);
  expect(match, `button ${label}`).toBeDefined();
  return match!;
}
async function click(label: string) { await act(async () => button(label).click()); }
async function input(label: string, value: string) {
  const element = [...host.querySelectorAll("input")].find((item) => item.getAttribute("aria-label") === label || item.placeholder === label)!;
  expect(element, `input ${label}`).toBeDefined();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submitAdd() { await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))); }

describe("service domain controls", () => {
  it("shows every routed port for this service without leaking a sibling's domains", async () => {
    await render();
    expect(host.textContent).toContain("app.example.com");
    expect(host.textContent).toContain("metrics.example.com");
    expect(host.textContent).not.toContain("other.example.com");
  });

  it("opens the selected port and lets the user see all service ports", async () => {
    await render({ serviceId: service.id, port: 9000 });
    expect(host.textContent).toContain("metrics.example.com");
    expect(host.textContent).not.toContain("app.example.com");
    await act(async () => {
      const select = host.querySelector("select")!;
      select.value = "";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(host.textContent).toContain("app.example.com");
    expect(host.textContent).not.toContain("other.example.com");
  });

  it("adds another hostname to the selected service and port without replacing existing routes", async () => {
    await render({ serviceId: service.id, port: 3000, add: true });
    await click(domains.addRoute.custom);
    await input(domains.add.domainName, "www.example.com");
    const port = host.querySelector<HTMLInputElement>(`input[aria-label="${copy.containerPort}"]`)!;
    expect(port.value).toBe("3000");
    expect(port.readOnly).toBe(true);
    await submitAdd();
    expect(mocks.update).toHaveBeenCalledOnce();
    const [projectId, id, patch] = mocks.update.mock.calls[0];
    expect([projectId, id]).toEqual(["project-stack", service.id]);
    expect(patch.publicEndpoints).toEqual([primary, secondary, { ...primary, customDomain: "www.example.com" }]);
    expect(patch.customDomain).toBe(primary.customDomain);
    expect(mocks.updateProject).not.toHaveBeenCalled();
    expect(mocks.edge).not.toHaveBeenCalled();
    expect(mocks.changed).toHaveBeenCalledOnce();
  });

  it("opens inline HTTPS setup for the persisted wildcard service domain without starting an order", async () => {
    context.projectData.deployTarget = "server";
    const wildcard = { id: "dom-wildcard", hostname: "*.tenant.example.com", serviceId: service.id,
      verified: false, status: "pending", domainType: "custom", sslStatus: "none", sslChallenge: "dns-01", isPrimary: false };
    mocks.listDomains.mockResolvedValue({ data: [...context.domainsData.domains, wildcard] });
    await render({ serviceId: service.id, port: 3000, add: true });
    await click(domains.addRoute.custom);
    await input(domains.add.domainName, wildcard.hostname);
    await submitAdd();
    expect(mocks.update.mock.calls[0][2].publicEndpoints).toEqual([primary, secondary, { ...primary, customDomain: wildcard.hostname }]);
    expect(host.querySelector(`section[aria-label="${domains.wildcard.title}: ${wildcard.hostname}"]`)).not.toBeNull();
    expect(mocks.dnsChallenge).toHaveBeenCalledWith(wildcard.id);
    expect(mocks.startDnsChallenge).not.toHaveBeenCalled();
    expect(mocks.verifyModal).not.toHaveBeenCalled();
    expect(host.querySelector('a[href="https://*.tenant.example.com"]')).toBeNull();
  });

  it("adds a project wildcard with DNS-01 and no www sibling after www was previously selected", async () => {
    context.projectData.deployTarget = "server";
    context.projectData.framework = "nextjs";
    context.projectData.serviceCount = 0;
    context.servicesData.services = [];
    context.domainsData.domains = [];
    const wildcard = { id: "dom-project-wildcard", hostname: "*.project.example.com", sslChallenge: "dns-01" };
    mocks.connect.mockResolvedValue({ success: true, domain: wildcard, records: { records: [] } });
    mocks.updateProject.mockResolvedValue({ success: true });
    await render(null);
    await click(domains.actions.addDomain);
    await click(domains.add.includeWww);
    await input(domains.add.customPlaceholder, wildcard.hostname);
    expect(button(domains.add.includeWww).disabled).toBe(true);
    await click(domains.add.submit);
    expect(mocks.connect).toHaveBeenCalledWith("project-stack", expect.objectContaining({
      domain: wildcard.hostname, includeWww: false, sslChallenge: "dns-01",
    }));
    const endpoints = mocks.updateProject.mock.calls[0][1].publicEndpoints;
    expect(endpoints.filter((endpoint: { customDomain?: string }) => endpoint.customDomain?.endsWith("project.example.com")))
      .toEqual([{ port: 3000, domainType: "custom", customDomain: wildcard.hostname }]);
    expect(host.querySelector(`section[aria-label="${domains.wildcard.title}: ${wildcard.hostname}"]`)).not.toBeNull();
    expect(mocks.dnsChallenge).toHaveBeenCalledWith(wildcard.id);
    expect(mocks.startDnsChallenge).not.toHaveBeenCalled();
  });

  it("keeps the add form and its values when the API rejects the change", async () => {
    mocks.update.mockRejectedValue(new Error("Domain is already in use"));
    await render({ serviceId: service.id, port: 9000, add: true });
    await click(domains.addRoute.custom);
    await input(domains.add.domainName, "new.example.com");
    await submitAdd();
    expect(host.querySelector("form")).not.toBeNull();
    expect(host.querySelector<HTMLInputElement>(`input[aria-label="${domains.add.domainName}"]`)?.value).toBe("new.example.com");
    expect(mocks.toast).toHaveBeenCalledWith("Domain is already in use", "error");
    expect(mocks.changed).not.toHaveBeenCalled();
  });

  it("edits the selected secondary route while preserving its primary and newly added siblings", async () => {
    await render({ serviceId: service.id, port: 9000 });
    await click(`${copy.manage} metrics.example.com`);
    await click(domains.menu.editRoute);
    const old = [...host.querySelectorAll("input")].find((element) => element.value === "metrics.example.com")!;
    expect(old).toBeDefined();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(old, "monitor.example.com");
      old.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const fresh = { port: 4000, domainType: "custom" as const, customDomain: "fresh.example.com" };
    mocks.get.mockResolvedValue({ success: true, service: { ...service, publicEndpoints: [primary, secondary, fresh] } });
    await click(domains.editRoute.save);
    expect(mocks.update.mock.calls[0][2].publicEndpoints).toEqual([primary, { ...secondary, customDomain: "monitor.example.com" }, fresh]);
  });

  it("removes the correct persisted domain and refreshes the service", async () => {
    await render({ serviceId: service.id, port: 9000 });
    await click(`${copy.manage} metrics.example.com`);
    await click("Remove route");
    await click("Remove route");
    expect(mocks.remove).toHaveBeenCalledExactlyOnceWith("dom-metrics");
    expect(mocks.refreshServices).toHaveBeenCalled();
    expect(mocks.changed).toHaveBeenCalledOnce();
  });

  it("removes an unclaimed service endpoint without changing project routes", async () => {
    context.domainsData.domains = context.domainsData.domains.filter((row) => row.id !== "dom-metrics");
    await render({ serviceId: service.id, port: 9000 });
    await click(`${copy.manage} metrics.example.com`);
    await click("Remove route");
    await click("Remove route");
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.update.mock.calls[0][2].publicEndpoints).toEqual([primary]);
    expect(mocks.updateProject).not.toHaveBeenCalled();
  });

  it("clears the last pending route without recreating it from legacy fields", async () => {
    context.domainsData.domains = [];
    context.servicesData.services = [{ ...service, publicEndpoints: [primary] }, other];
    await render();
    await click(`${copy.manage} app.example.com`);
    await click("Remove route");
    await click("Remove route");
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith("project-stack", service.id, {
      publicEndpoints: [], exposed: false, exposedPort: "", domainType: "free", domain: "", customDomain: "",
    });
    expect(host.textContent).not.toContain("app.example.com");
    expect(mocks.updateProject).not.toHaveBeenCalled();
  });

  it("keeps the project Routes page complete and requires a service for ambiguous ports", async () => {
    await render(null);
    expect(host.textContent).toContain("app.example.com");
    expect(host.textContent).toContain("metrics.example.com");
    expect(host.textContent).toContain("other.example.com");
    await click(domains.actions.addDomain);
    await click(domains.addRoute.custom);
    await input(domains.add.domainName, "another.example.com");
    await input(copy.containerPort, "3000");
    await submitAdd();
    expect(mocks.update).not.toHaveBeenCalled();
    await act(async () => {
      const select = host.querySelector<HTMLSelectElement>(`select[aria-label="${copy.service}"]`)!;
      select.value = service.id;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await submitAdd();
    expect(mocks.update.mock.calls[0].slice(0, 2)).toEqual(["project-stack", service.id]);
    expect(mocks.update.mock.calls[0][2].publicEndpoints).toEqual([primary, secondary, { ...primary, customDomain: "another.example.com" }]);
    expect(mocks.updateProject).not.toHaveBeenCalled();
  });

  it("verifies a Cloud-owned domain through Oblien even on a self-hosted dashboard", async () => {
    context.domainsData.domains.find((row) => row.id === "dom-metrics").verified = false;
    await render({ serviceId: service.id, port: 9000 });
    await click(domains.menu.verify);
    expect(mocks.verify).toHaveBeenCalledExactlyOnceWith("dom-metrics");
    expect(mocks.verifyModal).not.toHaveBeenCalled();
  });

  it("opens setup automatically for a service with no domains and never falls back to another service", async () => {
    context.servicesData.services = [{ ...service, publicEndpoints: [], exposed: false, domain: null, customDomain: null, domainType: null }, other];
    await render({ serviceId: service.id, port: 3000 });
    expect(host.querySelector("form")).not.toBeNull();
    expect(host.textContent).not.toContain("other.example.com");
  });

  it("shows an unavailable service instead of the project's other domains", async () => {
    await render({ serviceId: "deleted-service", port: 3000, add: true });
    expect(host.textContent).toContain(copy.serviceUnavailable);
    expect(host.textContent).not.toContain("other.example.com");
    expect(host.querySelector("form")).toBeNull();
  });
});
