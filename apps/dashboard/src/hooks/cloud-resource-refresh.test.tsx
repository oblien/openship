// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ home: vi.fn(), servers: vi.fn(), info: vi.fn(), services: vi.fn(), checkout: vi.fn() }));
vi.mock("@/lib/auth-client", () => ({ useSession: () => ({ data: { user: { id: "local-user" }, session: { activeOrganizationId: "local-org" } } }) }));
vi.mock("@/lib/api", () => ({ projectsApi: { getHome: h.home, getInfo: h.info, getCommitStatus: async () => ({ data: { supported: false } }) }, servicesApi: { list: h.services }, api: {}, endpoints: {}, ApiError: class extends Error {} }));
vi.mock("@/lib/api/system", () => ({ systemApi: { listServerDestinations: h.servers } }));
vi.mock("@/lib/api/client", async original => ({ ...await original<typeof import("@/lib/api/client")>(), api: { post: h.checkout } }));
vi.mock("@/lib/cloud-analytics", () => ({ trackCloudEvent: () => {} }));
vi.mock("@/context/PlatformContext", () => ({ usePlatform: () => ({ selfHosted: true }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));
import { CloudResourceContext } from "@/context/CloudResourceContext";
import { ProjectSettingsProvider, useProjectSettings } from "@/context/ProjectSettingsContext";
import { I18nProvider } from "@/components/i18n-provider";
import { useCloudCheckout } from "@/components/billing/useCloudBilling";
import { useDashboardHome } from "./useDashboardHome";
import { useServerDestinations } from "./useServerDestinations";
import { useProjectInfo, clearProjectEndpointCaches, invalidateProjectCaches } from "./useProjectEndpoints";

let root: Root, host: HTMLDivElement;
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const render = (scope: string, children: ReactNode) => act(async () => root.render(<CloudResourceContext.Provider value={scope}>{children}</CloudResourceContext.Provider>));
const home = (name: string) => ({ success: true, projects: [{ id: name, name }], numbers: {} });
const server = (name: string) => ({ servers: [{ id: name, name }] });
const project = (name: string) => ({ success: true, data: { project: { id: "project", name } } });
function Home({ initial }: { initial?: unknown }) { const { projects, loading } = useDashboardHome(initial); return <div>{loading ? "Loading" : projects.map(row => row.name).join(",")}</div>; }
function Servers() { const state = useServerDestinations(); return <div>{state.loading ? "Loading" : state.data?.servers.map(row => row.name).join(",")}</div>; }
function Project() { const state = useProjectInfo("project"); return <div>{state.isLoading ? "Loading" : state.data?.project.name}</div>; }
beforeEach(() => {
  vi.resetAllMocks(); clearProjectEndpointCaches();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.home.mockResolvedValue(home("Local project")); h.servers.mockResolvedValue(server("Own server"));
  h.services.mockResolvedValue({ success: true, services: [] });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); clearProjectEndpointCaches(); vi.unstubAllGlobals(); });

it("reconciles a server-rendered project list after connecting and disconnecting Cloud", async () => {
  const initial = home("Local project");
  await render("disconnected", <Home initial={initial} />);
  expect(h.home).not.toHaveBeenCalled();
  h.home.mockResolvedValue({ ...home("Local project"), projects: [...home("Local project").projects, ...home("Cloud project").projects] });
  await render("account-a", <Home initial={initial} />);
  expect(host.textContent).toBe("Local project,Cloud project");
  h.home.mockResolvedValue(home("Local project"));
  await render("disconnected", <Home initial={initial} />);
  expect(host.textContent).toBe("Local project");
  expect(h.home).toHaveBeenCalledTimes(2);
});

it("does not show a late server response from the previous Cloud account", async () => {
  const old = deferred<unknown>(), current = deferred<unknown>();
  h.servers.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  await render("account-a", <Servers />);
  await render("account-b", <Servers />);
  await act(async () => old.resolve(server("Old account server")));
  expect(host.textContent).toBe("Loading");
  await act(async () => current.resolve(server("Current server")));
  expect(host.textContent).toBe("Current server");
});

it("does not show a late project list from the previous Cloud account", async () => {
  const old = deferred<unknown>();
  h.home.mockReturnValueOnce(old.promise).mockResolvedValueOnce(home("Current project"));
  await render("account-a", <Home />);
  await render("account-b", <Home />);
  await act(async () => old.resolve(home("Old project")));
  expect(host.textContent).toBe("Current project");
});

it("partitions project detail caches and in-flight reads by connection identity", async () => {
  const old = deferred<unknown>();
  h.info.mockReturnValueOnce(old.promise).mockResolvedValueOnce(project("Current detail"));
  await render("account-a", <><Project /><Project /></>);
  expect(h.info).toHaveBeenCalledTimes(1);
  await render("account-b", <><Project /><Project /></>);
  expect(host.textContent).toBe("Current detailCurrent detail");
  await act(async () => old.resolve(project("Old detail")));
  expect(host.textContent).toBe("Current detailCurrent detail");
  h.info.mockResolvedValue(project("Updated detail"));
  await act(async () => invalidateProjectCaches("project"));
  expect(host.textContent).toBe("Updated detailUpdated detail");
  expect(h.info).toHaveBeenCalledTimes(3);
});

it("discards server-rendered project settings and late services when the Cloud identity changes", async () => {
  const oldInfo = deferred<unknown>(), currentInfo = deferred<unknown>(), oldServices = deferred<unknown>();
  h.info.mockReturnValueOnce(oldInfo.promise).mockReturnValueOnce(currentInfo.promise);
  h.services.mockReturnValueOnce(oldServices.promise).mockResolvedValue({ success: true, services: [{ id: "new-service", name: "Current service" }] });
  function Settings() {
    const { projectData, servicesData } = useProjectSettings();
    return <div>{projectData.name}:{servicesData.services.map(row => row.name).join(",")}</div>;
  }
  const page = <I18nProvider><ProjectSettingsProvider id="project" initialProjectData={{ id: "project", slug: "project", name: "Old settings", description: "", framework: "" }}><Settings /></ProjectSettingsProvider></I18nProvider>;
  await render("account-a", page);
  expect(host.textContent).toContain("Old settings");
  await render("account-b", page);
  expect(host.textContent).not.toContain("Old settings");
  await act(async () => {
    oldInfo.resolve(project("Old response"));
    oldServices.resolve({ success: true, services: [{ id: "old-service", name: "Old service" }] });
    currentInfo.resolve(project("Current settings"));
  });
  expect(host.textContent).toBe("Current settings:Current service");
});

it("does not open a checkout returned for a disconnected Cloud account", async () => {
  const old = deferred<unknown>();
  h.checkout.mockReturnValue(old.promise);
  const popup = { close: vi.fn(), opener: null, location: { href: "about:blank" } };
  const open = vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
  const started = vi.fn();
  function Checkout() {
    const checkout = useCloudCheckout({ enabled: true, preserveProject: true, onCheckoutStarted: started });
    return <button onClick={() => void checkout.startCheckout("hobby", "monthly")}>{checkout.subscribing ?? "Choose plan"}</button>;
  }
  const page = <I18nProvider><Checkout /></I18nProvider>;
  try {
    await render("account-a", page);
    await act(async () => host.querySelector("button")!.click());
    await render("account-b", page);
    await act(async () => old.resolve({ data: { checkoutUrl: "https://checkout.stripe.com/old-account" } }));
    expect(host.textContent).toBe("Choose plan");
    expect(popup.location.href).toBe("about:blank");
    expect(popup.close).toHaveBeenCalledOnce();
    expect(started).not.toHaveBeenCalled();
  } finally { open.mockRestore(); }
});
