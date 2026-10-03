// @vitest-environment happy-dom
import { act, useEffect, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getAppTemplate, type AppTemplate } from "@repo/core";
import { baseDictionary } from "@/i18n";
import { ModalProvider } from "@/context/ModalContext";
import { ApiError } from "@/lib/api/client";
import type { RoutingSettingsCardProps } from "@/components/routing/RoutingSettingsCard";
import type { CleanDeployProgressCard } from "@/components/deploy/CleanDeployProgress";
import type { BuildMessageCallbacks } from "@/lib/sseMessageProcessors";
import AppInstallPage from "./page";

const h = vi.hoisted(() => ({
  template: vi.fn(),
  hostFit: vi.fn(),
  services: vi.fn(),
  info: vi.fn(),
  install: vi.fn(),
  updateService: vi.fn(),
  updateSettings: vi.fn(),
  build: vi.fn(),
  buildStatus: vi.fn(),
  redeploy: vi.fn(),
  showCloudPricing: vi.fn(),
  callbacks: {} as BuildMessageCallbacks,
  connect: vi.fn(),
  disconnect: vi.fn(),
  toast: vi.fn(),
  requireCloud: vi.fn(),
  cloud: false,
  appId: "convex",
  query: "projectId=draft",
  router: { push: vi.fn(), replace: vi.fn() },
}));

vi.mock("@/lib/api", () => ({
  appsApi: {
    template: h.template,
    hostFit: h.hostFit,
    install: h.install,
    updateSettings: h.updateSettings,
  },
  servicesApi: { list: h.services, update: h.updateService },
  projectsApi: { getInfo: h.info },
  deployApi: { buildAccess: h.build, getBuildStatus: h.buildStatus, buildRedeploy: h.redeploy },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => h.router,
  useParams: () => ({ appId: h.appId }),
  useSearchParams: () => new URLSearchParams(h.query),
}));
vi.mock("@/components/i18n-provider", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/components/i18n-provider")>(),
  useI18n: () => ({ t: baseDictionary, locale: "en" }),
}));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ showToast: h.toast }) }));
vi.mock("@/context/PlatformContext", () => ({
  usePlatform: () => ({
    baseDomain: "example.test",
    deployMode: h.cloud ? "cloud" : "docker",
    selfHosted: !h.cloud,
  }),
}));
vi.mock("@/context/CloudContext", () => ({
  useCloud: () => ({ connected: h.cloud, loading: false, requireCloud: h.requireCloud }),
}));
vi.mock("@/hooks/useSSEConnection", () => ({
  useBuildStream: ({ callbacks }: { callbacks: BuildMessageCallbacks }) => {
    h.callbacks = callbacks;
    return { connect: h.connect, disconnect: h.disconnect };
  },
}));
vi.mock("@/hooks/useCloudDeployPricing", () => ({ useCloudDeployPricing: () => h.showCloudPricing }));
vi.mock("@/hooks/useLocalDeployGate", () => ({
  useLocalDeployGate: () => ({ blocks: () => false }),
}));
vi.mock("@/components/deploy/AppDestinationPicker", () => ({
  AppDestinationPicker: ({ value, onChange, onReadyChange, readOnly }: ComponentProps<typeof import("@/components/deploy/AppDestinationPicker").AppDestinationPicker>) => {
    useEffect(() => {
      if (!value && !readOnly) onChange({ deployTarget: h.cloud ? "cloud" : "server", serverId: h.cloud ? "managed-server" : "small-server" });
      onReadyChange?.(!!value?.serverId);
    }, [value, onChange, onReadyChange, readOnly]);
    return <button onClick={() => onChange({ deployTarget: "server", serverId: "small-server" })}>Select small server</button>;
  },
}));
vi.mock("@/components/routing/RoutingSettingsCard", () => ({
  RoutingSettingsCard: (props: RoutingSettingsCardProps) => (
    <div>
      <button type="button" onClick={() => props.onDomainTypeChange("custom")}>
        Use custom domain
      </button>
      <button type="button" onClick={() => props.onCustomDomainChange("app.example.test")}>
        Enter hostname
      </button>
      <button type="button" onClick={() => props.onCustomDomainChange("not-a-hostname")}>
        Enter invalid hostname
      </button>
      <input
        aria-label="Custom domain"
        value={props.customDomain}
        onChange={(event) => props.onCustomDomainChange(event.target.value)}
      />
      <input
        aria-label="Free domain"
        placeholder={props.projectName}
        value={props.domain}
        onChange={(event) => props.onDomainChange(event.target.value)}
      />
    </div>
  ),
}));
vi.mock("@/components/deploy/CleanDeployProgress", () => ({
  CleanDeployProgressCard: ({ phase, logs, recoveryAction, onRetry }: ComponentProps<typeof CleanDeployProgressCard>) => (
    <div data-phase={phase}>
      <pre>{logs}</pre>
      {recoveryAction && <button onClick={recoveryAction.onClick} disabled={recoveryAction.pending}>{recoveryAction.label}</button>}
      <button onClick={onRetry}>Back to form</button>
    </div>
  ),
  firstPublicHost: () => null,
}));
vi.mock("@/components/domains/DnsRecordsModal", () => ({
  default: ({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) => (
    <>
      <button onClick={onConfirm}>Deploy after DNS</button>
      <button onClick={onCancel}>Cancel DNS</button>
    </>
  ),
}));
vi.mock("@/components/LocalDeployComingSoonModal", () => ({
  LocalDeployComingSoonModal: () => null,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const template = getAppTemplate("convex")!;
const saved = {
  services: template.services!.map((service) => ({
    id: service.name,
    name: service.name,
    ports: [...(service.ports ?? [])],
    exposed: false,
    publicEndpoints: [],
  })),
};
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.cloud = false;
  h.appId = "convex";
  h.query = "projectId=draft";
  h.template.mockReset();
  h.hostFit.mockReset().mockResolvedValue({
    data: {
      minResources: null,
      capacity: { cpuCores: 0, memoryMb: 0, source: "unknown" },
      fit: { ok: true },
    },
  });
  h.services.mockReset();
  h.info.mockResolvedValue({ data: { project: { slug: "saved-convex", serverId: "small-server", deployTarget: "server" } } });
  h.install.mockResolvedValue({ data: { kind: "template", projectId: "installed-app" } });
  h.updateSettings.mockResolvedValue(undefined);
  h.updateService.mockResolvedValue(undefined);
  h.build.mockResolvedValue({ data: { deployment_id: "new-deployment" } });
  h.buildStatus.mockResolvedValue({ data: { status: "pending" } });
  h.redeploy.mockReset().mockResolvedValue({ data: { deployment_id: "retried-deployment" } });
  h.showCloudPricing.mockReset().mockReturnValue(false);
  h.requireCloud.mockResolvedValue(true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const controls = () => [...container.querySelectorAll<HTMLButtonElement>(
  'section[aria-labelledby^="endpoint-"] button[aria-haspopup="listbox"]',
)];
const choices = () => controls().map((control) => control.textContent?.trim());
const render = () =>
  act(async () =>
    root.render(
      <ModalProvider>
        <AppInstallPage />
      </ModalProvider>,
    ),
  );
const button = (label: string) => {
  const node = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent?.trim() === label,
  );
  expect(node, `button ${label}`).toBeDefined();
  return node!;
};
const click = (label: string) => act(async () => button(label).click());
const fill = (label: string, value: string) => act(async () => {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});

async function renderApp(
  options: { appId?: string; cloud?: boolean; draft?: boolean; template?: AppTemplate } = {},
) {
  h.cloud = options.cloud ?? true;
  h.appId = options.appId ?? "supabase";
  h.query = options.draft ? "projectId=draft" : "";
  const app = options.template ?? getAppTemplate(h.appId)!;
  h.template.mockResolvedValue({ data: app });
  h.services.mockResolvedValue({
    services: app.services!.map((service) => ({
      id: service.name,
      name: service.name,
      ports: [],
      exposed: false,
      publicEndpoints: [],
    })),
  });
  await render();
}

it("restores saved routes when a catalog refresh interrupts the draft read", async () => {
  const catalog = deferred<{ data: AppTemplate }>();
  const services = deferred<typeof saved>();
  h.template.mockReturnValue(catalog.promise);
  h.services.mockReturnValue(services.promise);
  await render();
  expect(choices()).toEqual(["Domain", "Domain", "Domain"]);

  await act(async () => catalog.resolve({ data: structuredClone(template) }));
  await act(async () => services.resolve(saved));
  expect(choices()).toEqual([
    "Port only (no domain)", "Port only (no domain)", "Port only (no domain)",
  ]);
});

it("preserves edits after a draft has finished loading when the catalog arrives later", async () => {
  const catalog = deferred<{ data: AppTemplate }>();
  h.template.mockReturnValue(catalog.promise);
  h.services.mockResolvedValue(saved);
  await render();
  expect(choices()[0]).toBe("Port only (no domain)");

  await act(async () => controls()[0].click());
  await act(async () => document.querySelector<HTMLButtonElement>('[role="option"]')!.click());
  expect(choices()[0]).toBe("Domain");

  await act(async () => catalog.resolve({ data: structuredClone(template) }));
  expect(choices()).toEqual(["Domain", "Port only (no domain)", "Port only (no domain)"]);
  expect(h.services).toHaveBeenCalledTimes(1);
});

it("waits for an adopted draft's saved routes before enabling installation", async () => {
  h.cloud = true;
  h.appId = "mongodb";
  h.query = "projectId=draft";
  h.template.mockResolvedValue({ data: getAppTemplate("mongodb")! });
  const savedRoutes = deferred<{ services: unknown[] }>();
  h.services.mockReturnValue(savedRoutes.promise);
  await render();
  expect(button("Install").disabled).toBe(true);
  expect(button(baseDictionary.projectSettings.appInstall.advanced).disabled).toBe(true);
  expect(container.querySelector("fieldset")?.disabled).toBe(true);
  await act(async () => savedRoutes.resolve({ services: [
    { id: "mongo-ui", name: "mongo-express", exposed: true, publicEndpoints: [{ port: 8081, domainType: "free", domain: "saved-mongo-ui" }] },
    { id: "mongo-db", name: "mongo", exposed: false, ports: [] },
  ] }));
  expect(button("Install").disabled).toBe(false);
  await click("Install");
  expect(h.install).not.toHaveBeenCalled();
  expect(h.updateService).toHaveBeenCalledWith("draft", "mongo-ui", expect.objectContaining({
    publicEndpoints: [{ port: 8081, domainType: "free", domain: "saved-mongo-ui" }],
  }));
  expect(h.build).toHaveBeenCalledOnce();
});

it("keeps a failed draft read blocked and offers a retry instead of saving template routes over it", async () => {
  h.cloud = true;
  h.appId = "mongodb";
  h.query = "projectId=draft";
  h.template.mockResolvedValue({ data: getAppTemplate("mongodb")! });
  h.services.mockRejectedValueOnce(new Error("Saved routes unavailable"));
  await render();
  expect(button("Install").disabled).toBe(true);
  expect(container.textContent).toContain("Couldn't load saved routing");
  h.services.mockResolvedValue({ services: [
    { id: "mongo-ui", name: "mongo-express", exposed: true, publicEndpoints: [{ port: 8081, domainType: "free", domain: "saved-mongo-ui" }] },
  ] });
  await click("Try again");
  expect(button("Install").disabled).toBe(false);
  expect(h.updateService).not.toHaveBeenCalled();
  expect(h.build).not.toHaveBeenCalled();
});

it("waits for catalog draft discovery and loads its saved custom domain before installing", async () => {
  h.cloud = true;
  h.appId = "mongodb";
  h.query = "";
  const catalog = deferred<unknown>();
  const savedRoutes = deferred<{ services: unknown[] }>();
  h.template.mockReturnValue(catalog.promise);
  h.services.mockReturnValue(savedRoutes.promise);
  await render();
  expect(button("Install").disabled).toBe(true);
  await click("Install");
  expect(h.install).not.toHaveBeenCalled();
  await act(async () => catalog.resolve({
    data: getAppTemplate("mongodb")!,
    draft: { projectId: "draft", slug: "mongodb", name: "MongoDB" },
  }));
  expect(button("Install").disabled).toBe(true);
  await act(async () => savedRoutes.resolve({ services: [
    { id: "mongo-ui", name: "mongo-express", exposed: true, publicEndpoints: [{ port: 8081, domainType: "custom", customDomain: "saved.example.test" }] },
  ] }));
  expect(button("Install").disabled).toBe(false);
  await click("Install");
  expect(h.install).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    routes: [{ service: "mongo-express", port: 8081, mode: "custom", customDomain: "saved.example.test" }],
  }));
  expect(button("Deploy after DNS")).toBeDefined();
  expect(h.build).not.toHaveBeenCalled();
});

it("blocks installation after catalog discovery fails and retries without changing entered values", async () => {
  h.cloud = true;
  h.appId = "mongodb";
  h.query = "";
  h.template.mockRejectedValueOnce(new Error("Catalog unavailable"));
  await render();
  expect(button("Install").disabled).toBe(true);
  expect(container.textContent).toContain("Couldn't load app details");
  expect(h.install).not.toHaveBeenCalled();
  const name = container.querySelector<HTMLInputElement>("#app-name")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "Team Mongo");
    name.dispatchEvent(new Event("input", { bubbles: true }));
  });
  h.template.mockResolvedValue({ data: getAppTemplate("mongodb")! });
  await click("Try again");
  expect(name.value).toBe("Team Mongo");
  expect(button("Install").disabled).toBe(false);
  expect(h.install).not.toHaveBeenCalled();
  await click("Install");
  await click("Use free domains");
  expect(h.install).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    name: "Team Mongo",
    routes: [{ service: "mongo-express", port: 8081, mode: "free" }],
  }));
});

it("returns to the catalog when the runtime catalog confirms the app no longer exists", async () => {
  h.appId = "removed-app";
  h.query = "";
  h.template.mockRejectedValueOnce(new ApiError(404, "Not Found", {}));
  await render();
  expect(h.router.replace).toHaveBeenCalledWith("/apps/new");
  expect(h.install).not.toHaveBeenCalled();
});

it("does not substitute template routing when a draft's project details fail to load", async () => {
  h.cloud = true;
  h.appId = "mongodb";
  h.query = "projectId=draft";
  h.template.mockResolvedValue({ data: getAppTemplate("mongodb")! });
  h.services.mockResolvedValue({ services: saved.services });
  h.info.mockRejectedValueOnce(new Error("Project unavailable"));
  await render();
  expect(button("Install").disabled).toBe(true);
  expect(container.textContent).toContain("Couldn't load saved routing");
  await click("Install");
  expect(h.updateService).not.toHaveBeenCalled();
  expect(h.build).not.toHaveBeenCalled();
  h.info.mockResolvedValue({ data: { project: { slug: "saved-mongodb", serverId: "managed-server", workspaceId: "managed-workspace" } } });
  await click("Try again");
  expect(button("Install").disabled).toBe(false);
});

it("confirms automatic domains without freezing the preview label before the project is created", async () => {
  await renderApp();
  await click("Install");
  expect(h.install).not.toHaveBeenCalled();
  expect(h.build).not.toHaveBeenCalled();
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Studio & API");
  expect(button("Install").disabled).toBe(true);
  await click("Use free domains");
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  expect(h.install).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      templateId: "supabase",
      routes: [{ service: "kong", port: 8000, mode: "free" }],
    }),
  );
  expect(h.build).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ projectId: "installed-app" }),
  );
});

it("lets a Cloud user return to missing domains before creating a Supabase project", async () => {
  await renderApp();
  await click("Use custom domain");
  await click("Install");
  const dialog = document.querySelector('[role="alertdialog"]');
  expect(dialog?.textContent).toContain("Studio & API");
  expect(h.install).not.toHaveBeenCalled();
  expect(h.build).not.toHaveBeenCalled();
  await click("Add domains");
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  expect(h.install).not.toHaveBeenCalled();
  expect(button("Install").disabled).toBe(false);
});

it("confirms Mongo Express's generated URL without treating the internal database as unrouted", async () => {
  await renderApp({ appId: "mongodb" });
  await act(async () => { button("Install").click(); button("Install").click(); });
  expect(h.install).not.toHaveBeenCalled();
  expect(h.updateSettings).not.toHaveBeenCalled();
  expect(h.updateService).not.toHaveBeenCalled();
  expect(h.build).not.toHaveBeenCalled();
  const dialog = document.querySelector('[role="dialog"]');
  expect(dialog?.textContent).toContain("Mongo Express");
  expect(dialog?.textContent).toContain("free public URLs");
  expect(dialog?.textContent).not.toContain("Database");
  await act(async () => { const confirm = button("Use free domains"); confirm.click(); confirm.click(); });
  expect(h.install).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    templateId: "mongodb",
    routes: [{ service: "mongo-express", port: 8081, mode: "free" }],
  }));
  expect(h.build).toHaveBeenCalledOnce();
});

it("returns to the domain editor and persists the typed hostname exactly", async () => {
  await renderApp({ appId: "mongodb" });
  await click("Install");
  await click("Edit domains");
  expect(h.install).not.toHaveBeenCalled();
  expect(h.build).not.toHaveBeenCalled();
  expect(container.querySelector<HTMLInputElement>('input[aria-label="Free domain"]')?.value)
    .toBe("");
  await fill("Free domain", "production-mongo-admin");
  await click("Install");
  expect(h.install).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    routes: [{ service: "mongo-express", port: 8081, mode: "free", domain: "production-mongo-admin" }],
  }));
  expect(h.build).toHaveBeenCalledOnce();
});

it("cancels a generated-domain confirmation when navigating away", async () => {
  await renderApp({ appId: "mongodb" });
  await click("Install");
  await act(async () => root.render(<ModalProvider><div>Another page</div></ModalProvider>));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(h.install).not.toHaveBeenCalled();
  expect(h.build).not.toHaveBeenCalled();
});

it("confirms missing and generated routes together and keeps one complete routing plan", async () => {
  await renderApp({ appId: "convex" });
  await click("Use custom domain");
  await click("Install");
  expect(h.install).not.toHaveBeenCalled();
  const dialog = document.querySelector('[role="alertdialog"]');
  expect(dialog?.textContent).toContain("Continue without domains?");
  expect(dialog?.textContent).toContain("free public URLs");
  await click("Continue without domains");
  expect(h.install).toHaveBeenCalledOnce();
  const routes = h.install.mock.calls[0][0].routes;
  expect(routes).toHaveLength(3);
  expect(routes.filter((route: { mode: string }) => route.mode === "port")).toHaveLength(1);
  expect(routes.filter((route: { mode: string; domain?: string }) => route.mode === "free" && !route.domain)).toHaveLength(2);
  expect(new Set(routes.map((route: { service: string; port: number }) => `${route.service}:${route.port}`)).size).toBe(3);
  expect(h.build).toHaveBeenCalledOnce();
});

it("only deploys Supabase without a domain after explicit confirmation, once", async () => {
  await renderApp();
  await click("Use custom domain");
  await act(async () => {
    button("Install").click();
    button("Install").click();
  });
  expect(document.querySelectorAll('[role="alertdialog"]')).toHaveLength(1);
  expect(h.install).not.toHaveBeenCalled();
  await act(async () => {
    const confirm = button("Continue without domains");
    confirm.click();
    confirm.click();
  });
  expect(h.install).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      templateId: "supabase",
      routes: [{ service: "kong", port: 8000, mode: "port" }],
    }),
  );
  expect(h.build).toHaveBeenCalledTimes(1);
});

it("warns about port-only public endpoints but not Supabase's internal database", async () => {
  await renderApp();
  await act(async () => controls()[0].click());
  const port = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((node) =>
    node.textContent?.includes("No public URL"),
  )!;
  await act(async () => port.click());
  await click("Install");
  const dialog = document.querySelector('[role="alertdialog"]');
  expect(dialog?.textContent).toContain("Studio & API");
  expect(dialog?.textContent).not.toContain("Database");
  expect(h.install).not.toHaveBeenCalled();
  await act(async () =>
    dialog!.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  expect(h.build).not.toHaveBeenCalled();
});

it("cancels domain confirmation when leaving the installer", async () => {
  await renderApp();
  await click("Use custom domain");
  await click("Install");
  expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
  await act(async () =>
    root.render(
      <ModalProvider>
        <div>Another page</div>
      </ModalProvider>,
    ),
  );
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  expect(h.install).not.toHaveBeenCalled();
  expect(h.build).not.toHaveBeenCalled();
});

it("applies the confirmed port-only choice to an adopted draft without recreating it", async () => {
  await renderApp({ cloud: false, draft: true });
  await click("Install");
  expect(h.updateService).not.toHaveBeenCalled();
  await click("Continue without domains");
  expect(h.install).not.toHaveBeenCalled();
  expect(h.updateService).toHaveBeenCalledWith(
    "draft",
    "kong",
    expect.objectContaining({
      exposed: false,
      publicEndpoints: [],
      domainType: "free",
      domain: null,
      customDomain: null,
      ports: ["0.0.0.0:8000:8000"],
    }),
  );
  expect(h.build).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ projectId: "draft" }));
});

it.each([
  { cloud: true, deployTarget: "cloud", serverId: "managed-host", workspaceId: "paid-workspace" },
  { cloud: false, deployTarget: "server", serverId: "saved-host", workspaceId: undefined },
])("restores the saved $deployTarget host when installing a draft", async ({ cloud, ...placement }) => {
  h.info.mockResolvedValue({ data: { project: { slug: "saved-app", ...placement } } });
  await renderApp({ cloud, draft: true });
  await click("Install");
  await click("Continue without domains");
  expect(h.install).not.toHaveBeenCalled();
  expect(h.build).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    projectId: "draft", serverId: placement.serverId, deployTarget: placement.deployTarget,
  }));
});

it("offers an upgrade before Cloud installation, then refreshes after returning from billing", async () => {
  const capacity = {
    minResources: null,
    capacity: { cpuCores: 0, memoryMb: 0, source: "unknown" },
    fit: { ok: true },
    cloud: {
      resources: { cpuCores: 4, memoryMb: 8192, diskMb: 40960 },
      status: "upgrade",
      message: "This app needs 4 vCPU; the plan allows 2 vCPU.",
    },
  };
  h.hostFit.mockResolvedValueOnce({ data: capacity });
  await renderApp();
  expect(container.textContent).toContain("This app needs 4 vCPU");
  const upgrade = [...container.querySelectorAll<HTMLAnchorElement>("a")].find((link) =>
    link.textContent?.includes("Upgrade plan"),
  );
  expect(upgrade?.getAttribute("href")).toBe("/billing/plans");
  expect(upgrade?.target).toBe("_blank");
  expect(h.install).not.toHaveBeenCalled();
  expect(h.build).not.toHaveBeenCalled();
  h.hostFit.mockResolvedValue({
    data: { ...capacity, cloud: { ...capacity.cloud, status: "ready" } },
  });
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(container.textContent).not.toContain("This app needs 4 vCPU");
  expect(h.build).not.toHaveBeenCalled();
  await click("Install");
  await click("Use free domains");
  expect(h.build).toHaveBeenCalledOnce();
});

it.each(["create", "deploy"])("opens subscription recovery at the app %s gate and retains the draft", async (gate) => {
  const refusal = new ApiError(402, "Payment required", { code: "CLOUD_BILLING_BLOCKED" });
  h.showCloudPricing.mockReturnValue(true);
  (gate === "create" ? h.install : h.build).mockRejectedValueOnce(refusal);
  await renderApp();
  await click("Install");
  await click("Use free domains");
  expect(h.showCloudPricing).toHaveBeenCalledWith(refusal, ...(gate === "deploy" ? [expect.any(Function)] : []));
  expect(h.connect).not.toHaveBeenCalled();
  expect(h.toast).not.toHaveBeenCalled();
  await click("Install");
  await click("Use free domains");
  expect(h.install).toHaveBeenCalledTimes(gate === "create" ? 2 : 1);
  expect(h.connect).toHaveBeenCalledWith("new-deployment", false);
});

it("recovers a capacity refusal before app deployment using the same configured draft", async () => {
  const refusal = new ApiError(409, "Capacity required", { code: "CLOUD_CAPACITY_REQUIRED", projectId: "installed-app" });
  h.showCloudPricing.mockReturnValue(true);
  h.build.mockRejectedValueOnce(refusal);
  await renderApp();
  await click("Install");
  await click("Use free domains");
  expect(h.showCloudPricing).toHaveBeenCalledWith(refusal, expect.any(Function));
  const retry = h.showCloudPricing.mock.calls[0]![1] as () => Promise<void>;
  await act(async () => { await retry(); });
  expect(h.install).toHaveBeenCalledOnce();
  expect(h.build).toHaveBeenCalledTimes(2);
  expect(h.build).toHaveBeenLastCalledWith(expect.objectContaining({ projectId: "installed-app" }));
  expect(h.connect).toHaveBeenCalledWith("new-deployment", false);
});

it("keeps failed app logs, opens capacity recovery, and resumes one deployment after adjustment", async () => {
  h.showCloudPricing.mockReturnValue(true);
  await renderApp();
  await click("Install");
  await click("Use free domains");
  h.buildStatus.mockImplementation(async (id: string) => ({ data: id === "new-deployment" ? {
    deploymentStatus: "failed", project_id: "installed-app", logs: "Preparing Cloud workspace\nPool is full\n",
    failureMessage: "Capacity required", errorCode: "CLOUD_CAPACITY_REQUIRED",
    errorDetails: { capacity: { requested: { cpuCores: 1, memoryMb: 1024, diskMb: 8192 } } },
  } : { deploymentStatus: "building" } }));
  await act(async () => { h.callbacks.onFailure?.("Capacity required"); });
  expect(container.textContent).toContain("Pool is full");
  expect(h.showCloudPricing).toHaveBeenCalledTimes(1);
  expect(h.showCloudPricing).toHaveBeenCalledWith(expect.objectContaining({
    status: 409,
    body: expect.objectContaining({ code: "CLOUD_CAPACITY_REQUIRED", projectId: "installed-app" }),
  }), expect.any(Function));
  // Closing the modal must leave recovery accessible alongside the same logs.
  await click(baseDictionary.billing.capacityEditor.title);
  expect(h.showCloudPricing).toHaveBeenCalledTimes(2);
  const retry = h.showCloudPricing.mock.calls[1]![1] as () => Promise<void>;
  const queued = deferred<unknown>();
  h.redeploy.mockReturnValueOnce(queued.promise);
  await act(async () => { void retry(); void retry(); });
  expect(h.redeploy).toHaveBeenCalledExactlyOnceWith("new-deployment");
  expect(button(baseDictionary.billing.capacityEditor.title).disabled).toBe(true);
  await act(async () => queued.resolve({ data: { deployment_id: "retried-deployment" } }));
  expect(h.install).toHaveBeenCalledOnce();
  expect(h.connect).toHaveBeenLastCalledWith("retried-deployment", false);
  expect(container.querySelector('[data-phase="installing"]')).not.toBeNull();
  expect(new URL(window.location.href).searchParams.get("projectId")).toBe("installed-app");
  h.buildStatus.mockResolvedValue({ data: { deploymentStatus: "ready", logs: "App is running\n" } });
  await act(async () => { h.callbacks.onSuccess?.(); });
  expect(container.querySelector('[data-phase="done"]')).not.toBeNull();
  expect(container.textContent).toContain("App is running");
});

it("uses structured stream errors if the final app status read is unavailable", async () => {
  h.showCloudPricing.mockReturnValue(true);
  await renderApp();
  await click("Install");
  await click("Use free domains");
  h.buildStatus.mockRejectedValue(new TypeError("Network unavailable"));
  await act(async () => { h.callbacks.onFailure?.("Capacity changed", "CLOUD_CAPACITY_REQUIRED", { projectId: "installed-app" }); });
  expect(h.showCloudPricing).toHaveBeenCalledWith(expect.objectContaining({
    status: 409, body: expect.objectContaining({ projectId: "installed-app" }),
  }), expect.any(Function));
});

it("restores capacity recovery when reopening a failed app installation", async () => {
  h.cloud = true;
  h.appId = "supabase";
  h.query = "projectId=installed-app&deployment=failed-deployment";
  h.template.mockResolvedValue({ data: getAppTemplate("supabase")! });
  h.services.mockResolvedValue({ services: [] });
  h.showCloudPricing.mockReturnValue(true);
  h.buildStatus.mockResolvedValue({ data: {
    deploymentStatus: "failed", project_id: "installed-app", logs: "Saved install logs\n",
    errorCode: "CLOUD_CAPACITY_REQUIRED",
  } });
  await render();
  expect(container.textContent).toContain("Saved install logs");
  expect(h.showCloudPricing).toHaveBeenCalledOnce();
  expect(h.build).not.toHaveBeenCalled();
  expect(h.install).not.toHaveBeenCalled();
});

it.each(["cancelled", "unknown"])("keeps %s app failures out of billing recovery", async (reason) => {
  h.showCloudPricing.mockReturnValue(true);
  await renderApp();
  await click("Install");
  await click("Use free domains");
  h.buildStatus.mockResolvedValue({ data: {
    deploymentStatus: reason === "cancelled" ? "cancelled" : "failed",
    errorCode: reason === "cancelled" ? "CLOUD_CAPACITY_REQUIRED" : "CLOUD_RUNTIME_PROXY_UNAVAILABLE",
  } });
  await act(async () => { h.callbacks.onFailure?.("Stopped"); });
  expect(h.showCloudPricing).not.toHaveBeenCalled();
});

it("shows a small host warning while still allowing an undersized self-hosted installation", async () => {
  const capacity = deferred<unknown>();
  h.hostFit.mockReturnValue(capacity.promise);
  await renderApp({ cloud: false });
  await click("Select small server");
  expect(button("Install").disabled).toBe(false);
  await act(async () =>
    capacity.resolve({
      data: {
        minResources: { cpuCores: 4, memoryMb: 8192 },
        capacity: { cpuCores: 2, memoryMb: 4096, source: "docker" },
        fit: { ok: false, memory: { needed: 8192, available: 4096 } },
      },
    }),
  );
  expect(container.textContent).toContain("You can continue.");
  await click("Install");
  await click("Continue without domains");
  expect(h.build).toHaveBeenCalledOnce();
});

it.each(["install", "advanced"])(
  "checks the renamed instance instead of an unrelated draft: %s",
  async (action) => {
    h.cloud = true;
    h.appId = "supabase";
    h.query = "";
    h.template.mockResolvedValue({
      data: getAppTemplate("supabase")!,
      draft: { projectId: "existing-draft", slug: "supabase", name: "Supabase" },
    });
    h.services.mockResolvedValue({ services: [] });
    h.hostFit.mockImplementation(async (_id, options) => ({
      data: {
        minResources: null,
        capacity: { cpuCores: 0, memoryMb: 0, source: "unknown" },
        fit: { ok: true },
        cloud: {
          resources: { cpuCores: 4, memoryMb: 8192, diskMb: 40960 },
          status: options.projectId === "existing-draft" ? "upgrade" : "ready",
          message: "The existing draft exceeds this plan.",
        },
      },
    }));
    await render();
    expect(container.textContent).toContain("The existing draft exceeds this plan.");
    const name = container.querySelector<HTMLInputElement>("#app-name")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        name,
        "Supabase analytics",
      );
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.textContent).not.toContain("The existing draft exceeds this plan.");
    expect(h.hostFit).toHaveBeenLastCalledWith(
      "supabase",
      expect.objectContaining({ projectId: undefined }),
    );
    await click(
      action === "install" ? "Install" : baseDictionary.projectSettings.appInstall.advanced,
    );
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Free domain"]')?.placeholder)
      .toBe("supabase-analytics-kong");
    await click("Use free domains");
    expect(h.install).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ name: "Supabase analytics" }),
    );
    if (action === "install") {
      expect(h.build).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ projectId: "installed-app" }),
      );
    } else {
      expect(h.router.push).toHaveBeenCalledOnce();
      expect(h.build).not.toHaveBeenCalled();
    }
  },
);

it("uses the created draft's current plan check after cancelling DNS confirmation", async () => {
  h.hostFit.mockImplementation(async (_id, options) => ({
    data: {
      minResources: null,
      capacity: { cpuCores: 0, memoryMb: 0, source: "unknown" },
      fit: { ok: true },
      cloud: {
        resources: { cpuCores: 4, memoryMb: 8192, diskMb: 40960 },
        status: options.projectId === "installed-app" ? "upgrade" : "ready",
        message: "The saved allocation needs a larger plan.",
      },
    },
  }));
  await renderApp();
  await click("Use custom domain");
  await click("Enter hostname");
  await click("Install");
  await click("Cancel DNS");
  expect(h.install).toHaveBeenCalledOnce();
  expect(h.build).not.toHaveBeenCalled();
  expect(h.hostFit).toHaveBeenLastCalledWith(
    "supabase",
    expect.objectContaining({ projectId: "installed-app" }),
  );
  expect(container.textContent).toContain("The saved allocation needs a larger plan.");
  expect(container.querySelector('a[href="/billing/plans"]')).not.toBeNull();
});

it.each([false, true])(
  "does not offer domainless installation when the endpoint requires a domain (draft: %s)",
  async (draft) => {
    const app = structuredClone(getAppTemplate("supabase")!);
    app.endpoints = app.endpoints!.map((endpoint) =>
      endpoint.kind === "http" ? { ...endpoint, allowedModes: ["domain"] } : endpoint,
    );
    await renderApp({ template: app, draft });
    if (!draft) await click("Use custom domain");
    await click("Install");
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(h.toast).toHaveBeenCalledWith(
      baseDictionary.projectSettings.appInstall.customRequired,
      "error",
    );
    expect(h.install).not.toHaveBeenCalled();
    expect(h.updateService).not.toHaveBeenCalled();
    expect(h.build).not.toHaveBeenCalled();
  },
);

it("blocks repeat submission while DNS confirmation is open and cancels it on navigation", async () => {
  await renderApp();
  await click("Use custom domain");
  await click("Enter hostname");
  const install = button("Install");
  await act(async () => install.click());
  expect(button("Deploy after DNS")).toBeDefined();
  expect(h.install).toHaveBeenCalledTimes(1);
  expect(h.build).not.toHaveBeenCalled();
  expect(install.disabled).toBe(true);
  await act(async () =>
    root.render(
      <ModalProvider>
        <div>Another page</div>
      </ModalProvider>,
    ),
  );
  expect(document.body.textContent).not.toContain("Deploy after DNS");
  expect(h.build).not.toHaveBeenCalled();
});

it("never converts an invalid nonempty hostname into a domainless install", async () => {
  await renderApp();
  await click("Use custom domain");
  await click("Enter invalid hostname");
  await click("Install");
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  expect(h.toast).toHaveBeenCalledWith(
    expect.stringContaining("isn't a valid domain name"),
    "error",
  );
  expect(h.install).not.toHaveBeenCalled();
  expect(h.build).not.toHaveBeenCalled();
});
