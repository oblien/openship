// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseDictionary } from "@/i18n";
import { DEFAULT_CONFIG, INITIAL_STATE, createPublicEndpoint, normalizeComposeService, type DeploymentContextType } from "@/context/deployment/types";
import { encodeLocalSlug } from "@/utils/repoSlug";
import { DeploymentActions, DeploymentConfigurationAction } from "./DeploymentActions";
import { DeploymentHeader } from "./DeploymentHeader";
import { getDeploymentSites } from "./deployment-sites";

const mocks = vi.hoisted(() => ({ push: vi.fn(), invalidate: vi.fn(), stop: vi.fn(), baseDomain: "apps.example.test" }));
let deployment: Pick<DeploymentContextType, "config" | "state" | "deploymentStatus" | "stopDeployment">;
vi.mock("@/context/DeploymentContext", () => ({ useDeployment: () => deployment }));
vi.mock("@/context/PlatformContext", () => ({ usePlatform: () => ({ baseDomain: mocks.baseDomain }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/hooks/useProjectEndpoints", () => ({ invalidateProjectCaches: mocks.invalidate }));
vi.mock("@/components/i18n-provider", () => ({
  useI18n: () => ({ t: baseDictionary }),
  interpolate: (text: string, values: Record<string, string>) => text.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? key),
}));

const copy = baseDictionary.importProject.deploymentProcessing;
const endpoint = (hostname: string) => createPublicEndpoint({ domainType: "custom", customDomain: hostname, port: "3000" });
let root: Root;
let host: HTMLDivElement;
const redeploy = vi.fn<() => Promise<string | null>>();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.baseDomain = "apps.example.test";
  redeploy.mockResolvedValue(null);
  deployment = {
    config: { ...structuredClone(DEFAULT_CONFIG), projectId: "project", projectName: "Example", publicEndpoints: [] },
    state: { ...structuredClone(INITIAL_STATE), projectId: "project", deploymentId: "deployment", deploymentSuccess: true },
    deploymentStatus: "ready",
    stopDeployment: mocks.stop,
  };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
async function render(header = false) {
  await act(async () => root.render(header ? <DeploymentHeader onRedeploy={redeploy} /> : <DeploymentActions onRedeploy={redeploy} />));
}
function button(label: string) {
  return [...host.querySelectorAll("button")].find(element => element.getAttribute("aria-label") === label || element.textContent === label)!;
}
async function openSites() {
  await act(async () => button(copy.openSite).click());
  return host.querySelector<HTMLUListElement>("nav ul")!;
}
function compose() {
  deployment.config.projectType = "services";
  deployment.config.serviceDeploymentMode = "services";
  deployment.config.services = [
    normalizeComposeService({ id: "svc-api", name: "api", exposed: true, publicEndpoints: [endpoint("api.example.com"), endpoint("api-alias.example.com")] }),
    normalizeComposeService({ id: "svc-web", name: "web", exposed: true, publicEndpoints: [endpoint("www.example.com")] }),
  ];
}

describe("deployment destinations", () => {
  it("opens the sole public hostname directly", async () => {
    deployment.config.publicEndpoints = [endpoint("  WWW.Example.com  ")];
    await render();
    const link = [...host.querySelectorAll("a")].find(element => element.textContent === copy.openSite)!;
    expect(link.getAttribute("href")).toBe("https://www.example.com");
    expect(link.target).toBe("_blank");
    expect(link.rel).toContain("noopener");
    expect(button(copy.openSite)).toBeUndefined();
  });

  it("offers every Compose service domain and follows the chosen link, including aliases", async () => {
    compose();
    await render();
    expect(host.querySelector('a[href="https://api.example.com"]')).toBeNull();
    const list = await openSites();
    const links = [...list.querySelectorAll("a")];
    expect(links.map(link => link.href)).toEqual(["https://api.example.com/", "https://api-alias.example.com/", "https://www.example.com/"]);
    expect(links[1].textContent).toContain("api");
    expect(links[2].textContent).toContain("web");
    const navigate = vi.fn();
    links[2].addEventListener("click", event => { event.preventDefault(); navigate((event.currentTarget as HTMLAnchorElement).href); });
    await act(async () => links[2].click());
    expect(navigate).toHaveBeenCalledWith("https://www.example.com/");
    expect(host.querySelector("nav ul")).toBeNull();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("offers a picker for a single application's multiple endpoints too", async () => {
    deployment.config.publicEndpoints = [endpoint("example.com"), endpoint("www.example.com")];
    await render();
    expect([...(await openSites()).querySelectorAll("a")].map(link => link.hostname)).toEqual(["example.com", "www.example.com"]);
  });

  it("deduplicates hostnames while retaining the services they belong to", () => {
    compose();
    deployment.config.services[0].publicEndpoints = [endpoint("EXAMPLE.com"), endpoint(" example.com ")];
    deployment.config.services[1].publicEndpoints = [endpoint("example.com")];
    expect(getDeploymentSites(deployment.config, deployment.state.serviceStatuses, mocks.baseDomain)).toEqual([{ hostname: "example.com", serviceNames: ["api", "web"] }]);
  });

  it("omits failed and private services, and supports older service domain fields", () => {
    compose();
    deployment.state.serviceStatuses = [{ serviceId: "svc-api", serviceName: "api", status: "failed" }];
    deployment.config.services.push(normalizeComposeService({ name: "private", exposed: false, publicEndpoints: [endpoint("private.example.com")] }));
    deployment.config.services.push(normalizeComposeService({ name: "legacy", exposed: true, domainType: "custom", customDomain: "legacy.example.com" }));
    expect(getDeploymentSites(deployment.config, deployment.state.serviceStatuses, mocks.baseDomain).map(site => site.hostname)).toEqual(["www.example.com", "legacy.example.com"]);
  });

  it("does not manufacture a free hostname without a base domain", async () => {
    mocks.baseDomain = "";
    deployment.config.publicEndpoints = [createPublicEndpoint({ domain: "example", domainType: "free" }), endpoint("custom.example.com")];
    await render();
    expect(host.querySelector('a[href="https://custom.example.com"]')).not.toBeNull();
    expect(getDeploymentSites(deployment.config, [], mocks.baseDomain)).toHaveLength(1);
  });

  it("resolves configured free domains without using the project display name", () => {
    deployment.config.projectName = "Not A Hostname";
    deployment.config.publicEndpoints = [createPublicEndpoint({ domain: "chosen", domainType: "free" })];
    expect(getDeploymentSites(deployment.config, [], mocks.baseDomain)[0].hostname).toBe("chosen.apps.example.test");
  });

  it.each(["private", "empty", "wildcard"])("does not offer an unusable Open site action for %s routing", async mode => {
    deployment.config.noPublicRoute = mode === "private";
    deployment.config.publicEndpoints = mode === "empty" ? [] : [endpoint(mode === "wildcard" ? "*.example.com" : "example.com")];
    await render();
    expect(host.textContent).not.toContain(copy.openSite);
    await act(async () => button(copy.openProject).click());
    expect(mocks.invalidate).toHaveBeenCalledWith("project");
    expect(mocks.push).toHaveBeenCalledWith("/projects/project");
  });

  it("dismisses the picker with Escape and restores keyboard focus", async () => {
    compose();
    await render();
    const list = await openSites();
    const link = list.querySelector("a")!;
    await act(async () => { link.focus(); link.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(button(copy.openSite).getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(button(copy.openSite));
  });
});

describe("shared deployment controls", () => {
  it("keeps cancellation pending until the worker has acknowledged it", async () => {
    deployment.deploymentStatus = "cancelled";
    deployment.state.cancellationPending = true;
    await render();
    expect(button(copy.stopping).disabled).toBe(true);
    expect(button(copy.redeploy)).toBeUndefined();
    expect(host.textContent).not.toContain(copy.openSite);
  });

  it("stops an active deployment and disables the action while stopping", async () => {
    deployment.deploymentStatus = "building";
    await render();
    await act(async () => button(copy.stopDeployment).click());
    expect(mocks.stop).toHaveBeenCalledTimes(1);
    deployment.state.isStopping = true;
    await render();
    expect(button(copy.stopping).disabled).toBe(true);
  });

  it("sends one redeploy request and re-enables retry when no build was created", async () => {
    deployment.deploymentStatus = "failed";
    let finish!: (value: string | null) => void;
    redeploy.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    await render();
    const retry = button(copy.redeploy);
    await act(async () => { retry.click(); retry.click(); });
    expect(redeploy).toHaveBeenCalledTimes(1);
    expect(button(copy.redeploying).disabled).toBe(true);
    await act(async () => finish(null));
    expect(button(copy.redeploy).disabled).toBe(false);
  });

  it("uses the project header and correct configuration link for a local source", async () => {
    deployment.config.localPath = "/workspace/example";
    await render(true);
    expect(host.querySelector("h1")?.textContent).toBe("Example");
    expect(host.querySelector('header nav a')?.getAttribute("href")).toBe("/projects/project/deployments");
    expect(host.querySelector("header")?.textContent).not.toContain("undefined/");
    await act(async () => root.render(<DeploymentConfigurationAction />));
    expect(host.querySelector(`a[href^="/deploy/${encodeLocalSlug('/workspace/example')}"]`)).not.toBeNull();
  });
});
