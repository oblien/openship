// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
import type { AppConnectionOutput } from "@/lib/api/apps";
import { OverviewTab } from "./OverviewTab";

const h = vi.hoisted(() => ({
  connection: vi.fn(),
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
vi.mock("@/lib/api/apps", () => ({ appsApi: { getConnection: h.connection } }));
vi.mock("@/hooks/useLocalhostForward", () => ({
  useLocalhostForward: () => ({ canForward: false }),
}));
vi.mock("./ConnectedServicesCard", () => ({ ConnectedServicesCard: () => null }));
vi.mock("./UsedByCard", () => ({ UsedByCard: () => null }));
vi.mock("./UseInProjectModal", () => ({
  UseInProjectModal: ({
    sourceProjectId,
    outputs,
  }: {
    sourceProjectId: string;
    outputs: AppConnectionOutput[];
  }) => (
    <div role="dialog">
      {sourceProjectId}: {outputs.map((o) => o.value).join(", ")}
    </div>
  ),
}));

let root: Root;
let container: HTMLDivElement;
const output: AppConnectionOutput = {
  id: "internal",
  label: "Internal address",
  value: "http://api:3000",
  secret: false,
  service: null,
  internal: true,
};
async function render() {
  await act(async () =>
    root.render(
      <I18nProvider>
        <OverviewTab />
      </I18nProvider>,
    ),
  );
}
function useButton() {
  return [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("Use in a project"),
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  h.project = {
    id: "project-one",
    name: "API",
    slug: "api",
    isApp: false,
    hasServer: true,
    workloadType: "web",
    productionMode: "server",
    port: 3000,
    deployTarget: "server",
    serverId: "server-one",
  };
  h.services = [];
  h.connection.mockReset().mockResolvedValue({ data: { outputs: [output] } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("overview connection discovery", () => {
  it("keeps a regular project's connection panel out of Overview", async () => {
    await render();
    expect(h.connection).not.toHaveBeenCalled();
    expect(useButton()).toBeUndefined();
    expect(container.textContent).not.toContain("Internal address");
  });

  it("lets catalog apps open the existing connection flow from Overview", async () => {
    h.project.isApp = true;
    h.project.appTemplateId = "database";
    await render();
    expect(h.connection).toHaveBeenCalledWith("project-one");
    expect(useButton()).toBeDefined();
    await act(async () => useButton()!.click());
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain(
      "project-one: http://api:3000",
    );
  });

  it("does not load connection outputs for a static project", async () => {
    h.project.workloadType = "static";
    h.project.hasServer = false;
    h.connection.mockResolvedValue({ data: { outputs: [] } });
    await render();
    expect(h.connection).not.toHaveBeenCalled();
    expect(useButton()).toBeUndefined();
  });

  it("keeps a static project's attached service sharing out of Overview", async () => {
    h.project.workloadType = "static";
    h.project.hasServer = false;
    h.project.productionMode = "static";
    h.services = [{ id: "redis", name: "redis", ports: ["6379"], enabled: true }];
    h.connection.mockResolvedValue({
      data: { outputs: [{ ...output, value: "redis://redis:6379" }] },
    });
    await render();
    expect(h.connection).not.toHaveBeenCalled();
    expect(useButton()).toBeUndefined();
  });

  it("does not offer a synthesized Docker-network address for a cloud project", async () => {
    h.project.deployTarget = "cloud";
    await render();
    expect(h.connection).not.toHaveBeenCalled();
    expect(useButton()).toBeUndefined();
  });
});
