// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
import { OverviewTab } from "./OverviewTab";

const h = vi.hoisted(() => ({
  project: {} as Record<string, unknown>,
  services: [] as Array<Record<string, unknown>>,
}));
vi.mock("@/context/ProjectSettingsContext", () => ({
  useProjectSettings: () => ({
    projectData: h.project,
    buildData: {},
    id: "project-one",
    setActiveTab: vi.fn(),
    servicesData: { isLoading: false, services: h.services },
    selectedDomain: "",
    domain: "",
    domainsData: { domains: [] },
  }),
}));
vi.mock("@/hooks/useProjectEndpoints", () => ({
  useProjectInfo: () => ({ isLoading: false }),
  useAnalyticsData: () => ({ data: null, isLoadingSummary: false, isLoadingPeriods: false }),
}));
vi.mock("@/hooks/useLocalhostForward", () => ({
  useLocalhostForward: () => ({ canForward: false }),
}));
vi.mock("./ConnectedServicesCard", () => ({ ConnectedServicesCard: () => null }));
vi.mock("./UsedByCard", () => ({ UsedByCard: () => null }));

let root: Root;
let container: HTMLDivElement;
async function render() {
  await act(async () =>
    root.render(
      <I18nProvider>
        <OverviewTab />
      </I18nProvider>,
    ),
  );
}

function services(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `service-${i}`,
    name: `service-${i}`,
    ports: [],
    enabled: true,
  }));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  // The #1670 reporter's project: a Compose import (11 services) whose record
  // has no workloadType and hasServer false, so the workload resolves to
  // static even though nothing about it is a static site.
  h.project = {
    id: "project-one",
    name: "Compose stack",
    slug: "compose-stack",
    isApp: false,
    framework: "unknown",
    productionMode: "static",
    runtimeMode: "docker",
    projectType: "services",
    serviceCount: 11,
    hasServer: false,
    deployTarget: "server",
    serverId: "server-one",
  };
  h.services = services(11);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("overview mode label for Compose stacks", () => {
  it("labels a Compose services project as a Compose stack with its service count, not a Static Site", async () => {
    await render();
    expect(container.textContent).toContain("Compose stack");
    expect(container.textContent).toContain("11 services");
    expect(container.textContent).not.toContain("Static Site");
  });

  it("uses the singular form for a one-service Compose stack", async () => {
    h.project.serviceCount = 1;
    h.services = services(1);
    await render();
    expect(container.textContent).toContain("Compose stack");
    expect(container.textContent).toContain("1 service");
    expect(container.textContent).not.toContain("Static Site");
  });

  it("keeps a plain static site labelled Static Site", async () => {
    h.project = {
      id: "project-one",
      name: "Static site",
      slug: "static-site",
      isApp: false,
      framework: "unknown",
      productionMode: "static",
      projectType: "app",
      serviceCount: 0,
      hasServer: false,
      workloadType: "static",
      deployTarget: "server",
      serverId: "server-one",
    };
    h.services = [];
    await render();
    expect(container.textContent).toContain("Static Site");
    expect(container.textContent).not.toContain("Compose stack");
  });
});
