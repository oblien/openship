// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseDictionary } from "@/i18n";
import { DEFAULT_CONFIG, INITIAL_STATE, createPublicEndpoint, normalizeComposeService, type DeploymentContextType } from "@/context/deployment/types";
import ComposeDeploymentProcessing from "./compose/ComposeDeploymentProcessing";
import DeploymentProcessing from "./DeploymentProcessing";

const mocks = vi.hoisted(() => ({
  info: vi.fn(), push: vi.fn(), stop: vi.fn(), ready: vi.fn(), respond: vi.fn(),
  showModal: vi.fn(), hideModal: vi.fn(), showToast: vi.fn(), pricing: vi.fn(),
}));
let deployment: Pick<DeploymentContextType, "config" | "state" | "deploymentStatus" | "stopDeployment" | "onTerminalReady" | "respondToPrompt" | "steps" | "terminalRef">;
vi.mock("@/context/DeploymentContext", () => ({ useDeployment: () => deployment }));
vi.mock("@/context/PlatformContext", () => ({ usePlatform: () => ({ baseDomain: "apps.example.test" }) }));
vi.mock("@/components/theme-provider", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("@/context/ModalContext", () => ({ useModal: () => ({ showModal: mocks.showModal, hideModal: mocks.hideModal }) }));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ showToast: mocks.showToast }) }));
vi.mock("@/hooks/useCloudDeployPricing", () => ({ useCloudDeployPricing: () => mocks.pricing }));
vi.mock("@/hooks/useProjectEndpoints", () => ({ invalidateProjectCaches: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/lib/api", () => ({ projectsApi: { getInfo: mocks.info }, deployApi: {} }));
vi.mock("./PortAdvisoryModal", () => ({ PortAdvisoryModal: () => null }));
vi.mock("@/components/i18n-provider", () => ({
  useI18n: () => ({ t: baseDictionary }),
  interpolate: (text: string, values: Record<string, string>) => text.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? key),
}));
// Model xterm's imperative buffer, so the real page still controls routing,
// repainting, and visibility of each service's output.
vi.mock("./BuildTerminal", async () => {
  const { useEffect, useRef, useState } = await import("react");
  return { default: function TestTerminal({ onReady }: { onReady: (terminal: Terminal) => void }) {
    const [output, setOutput] = useState("");
    const onReadyRef = useRef(onReady);
    onReadyRef.current = onReady;
    useEffect(() => {
      onReadyRef.current({
        reset: () => setOutput(""),
        write: (text: string | Uint8Array) => setOutput(previous => previous + (typeof text === "string" ? text : new TextDecoder().decode(text))),
        scrollToBottom: () => {},
        buffer: { active: { viewportY: 0, baseY: 0 } },
      } as unknown as Terminal);
    }, []);
    return <pre data-build-terminal className="h-full overflow-auto p-5 font-mono text-xs leading-relaxed text-foreground">{output}</pre>;
  } };
});
vi.mock("./compose/LiveServiceLogsTerminal", () => ({
  LiveServiceLogsTerminal: ({ serviceId, active }: { serviceId: string; active: boolean }) => (
    <pre data-live-service={serviceId} data-active={active}>Runtime: {serviceId}</pre>
  ),
}));

const copy = baseDictionary.importProject.deploymentProcessing;
const composeCopy = baseDictionary.importProject.composeDeployment;
const redeploy = vi.fn<() => Promise<string | null>>();
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.info.mockResolvedValue({ data: { project: { activeDeploymentId: "dep-newer" } } });
  redeploy.mockResolvedValue(null);
  deployment = {
    config: {
      ...structuredClone(DEFAULT_CONFIG), projectId: "project", projectName: "ClinicAI",
      owner: "clinicai", repo: "platform", deployTarget: "server", serverId: "server", serverName: "Production",
      projectType: "services", serviceDeploymentMode: "services",
      services: [
        normalizeComposeService({ id: "svc-api", name: "api", build: ".", exposed: true, publicEndpoints: [createPublicEndpoint({ domainType: "custom", customDomain: "api.clinicai.example", port: "4010" })] }),
        normalizeComposeService({ id: "svc-web", name: "web", build: ".", exposed: true, publicEndpoints: [createPublicEndpoint({ domainType: "custom", customDomain: "clinicai.example", port: "3000" })] }),
        normalizeComposeService({ id: "svc-db", name: "postgres", image: "postgres:17" }),
      ],
    },
    state: {
      ...structuredClone(INITIAL_STATE), projectId: "project", deploymentId: "dep_yj93hiin6h1XUSc3",
      deploymentSuccess: true, buildDurationMs: 64000, currentStepIndex: 2,
      serviceStatuses: [
        { serviceId: "svc-api", serviceName: "api", status: "running" },
        { serviceId: "svc-web", serviceName: "web", status: "running" },
        { serviceId: "svc-db", serviceName: "postgres", status: "running" },
      ],
      buildLogs: [
        { type: "info", text: "Cloning repository…\nChecking deployment configuration…", time: "12:00:00" },
        { type: "info", text: "api build output", time: "12:00:01", serviceId: "svc-api" },
        { type: "info", text: "web build output", time: "12:00:02", serviceName: "web" },
        { type: "info", text: "postgres pull output", time: "12:00:03", serviceName: "postgres" },
      ],
    },
    deploymentStatus: "ready",
    stopDeployment: mocks.stop, onTerminalReady: mocks.ready, respondToPrompt: mocks.respond,
    steps: [{ label: "Prepare", icon: "server" }, { label: "Build", icon: "wrench" }, { label: "Deploy", icon: "rocket" }],
    terminalRef: { current: null },
  };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

async function render(compose = true) {
  await act(async () => root.render(compose ? <ComposeDeploymentProcessing onRedeploy={redeploy} /> : <DeploymentProcessing onRedeploy={redeploy} />));
}
function tab(label: string) {
  return [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(element => element.textContent === label)!;
}
function panel() { return host.querySelector<HTMLElement>('[role="tabpanel"][aria-hidden="false"]')!; }
async function select(label: string) { await act(async () => tab(label).click()); }

describe("build pages", () => {
  it.each([true, false])("uses one shared header and action set (Compose: %s)", async compose => {
    if (!compose) {
      deployment.config.projectType = "app";
      deployment.config.serviceDeploymentMode = "single";
      deployment.config.publicEndpoints = deployment.config.services[0].publicEndpoints!;
    }
    await render(compose);
    expect(host.querySelectorAll("h1")).toHaveLength(1);
    expect(host.querySelector("h1")?.textContent).toBe("ClinicAI");
    for (const label of [copy.openProject, composeCopy.editConfiguration]) {
      const controls = [...host.querySelectorAll("button, a")].filter(element => element.textContent === label);
      expect(controls).toHaveLength(1);
      expect(controls[0].closest(label === copy.openProject ? "header" : "section[aria-label]"))
        .not.toBeNull();
    }
    expect(host.querySelector('a[href="/servers/server"]')).not.toBeNull();
    expect(mocks.ready).toHaveBeenCalledTimes(1);
    if (!compose) expect(deployment.terminalRef.current).not.toBeNull();
  });

  it("keeps shared preparation and each service's historical output separate across switches", async () => {
    await render();
    expect(panel().textContent).toContain("Cloning repository");
    expect(panel().textContent).not.toContain("build output");
    for (const service of ["api", "web", "postgres", "api"]) {
      await select(service);
      expect(panel().textContent).toBe(service === "postgres" ? "postgres pull output\r\n" : `${service} build output\r\n`);
      expect(host.querySelectorAll('[role="tabpanel"][aria-hidden="false"]')).toHaveLength(1);
      expect(panel().getAttribute("aria-labelledby")).toBe(tab(service).id);
      expect(tab(service).getAttribute("aria-controls")).toBe(panel().id);
    }
    expect(host.querySelector("[data-live-service]")).toBeNull();
    expect(host.textContent).not.toContain(copy.productionLogs);
  });

  it("switches service panels with the keyboard and preserves browser modifier shortcuts", async () => {
    await render();
    expect(host.querySelector('[role="tablist"]')?.getAttribute("aria-orientation")).toBe("horizontal");
    const prepare = tab(composeCopy.prepareTab);
    await act(async () => { prepare.focus(); prepare.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
    expect(tab("api").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tab("api"));
    await act(async () => tab("api").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(document.activeElement).toBe(tab("postgres"));
    await act(async () => tab("postgres").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    expect(document.activeElement).toBe(tab("web"));
    await act(async () => tab("web").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })));
    expect(document.activeElement).toBe(prepare);
    await act(async () => tab("api").dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
    expect(document.activeElement).toBe(tab("postgres"));
    await act(async () => tab("postgres").dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })));
    expect(document.activeElement).toBe(prepare);
    await act(async () => prepare.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", ctrlKey: true, bubbles: true })));
    expect(document.activeElement).toBe(prepare);
    await act(async () => prepare.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })));
    expect(document.activeElement).toBe(tab("web"));
    expect(panel().textContent).toContain("web build output");
    expect(host.querySelectorAll('[role="tab"][tabindex="0"]')).toHaveLength(1);
  });

  it("keeps vertical arrow navigation in its column when the last grid row is unpaired", async () => {
    deployment.config.services.push(normalizeComposeService({ id: "svc-worker", name: "worker", image: "example/worker" }));
    await render();
    const prepare = tab(composeCopy.prepareTab);
    await act(async () => { prepare.focus(); prepare.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })); });
    expect(document.activeElement).toBe(tab("worker"));
    await act(async () => tab("worker").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(document.activeElement).toBe(prepare);
    await select("api");
    await act(async () => tab("api").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(document.activeElement).toBe(tab("postgres"));
    await act(async () => tab("postgres").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(document.activeElement).toBe(tab("api"));
  });

  it("reverses horizontal grid navigation for right-to-left layouts", async () => {
    await render();
    for (const element of host.querySelectorAll<HTMLElement>('[role="tab"]')) element.style.direction = "rtl";
    const prepare = tab(composeCopy.prepareTab);
    await act(async () => { prepare.focus(); prepare.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })); });
    expect(document.activeElement).toBe(tab("api"));
    await act(async () => tab("api").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(document.activeElement).toBe(prepare);
  });

  it("enables runtime output only for the selected service of the current successful deployment", async () => {
    mocks.info.mockResolvedValue({ data: { project: { activeDeploymentId: deployment.state.deploymentId } } });
    await render();
    expect(host.querySelectorAll('[data-live-service][data-active="true"]')).toHaveLength(0);
    await select("api");
    expect(host.querySelectorAll('[data-live-service][data-active="true"]')).toHaveLength(1);
    expect(panel().querySelector("[data-live-service]")?.getAttribute("data-live-service")).toBe("svc-api");
    expect(host.textContent).toContain(copy.productionLogs);
    await select("web");
    expect(host.querySelectorAll('[data-live-service][data-active="true"]')).toHaveLength(1);
    expect(panel().querySelector("[data-live-service]")?.getAttribute("data-live-service")).toBe("svc-web");
    await select(composeCopy.prepareTab);
    expect(host.querySelectorAll('[data-live-service][data-active="true"]')).toHaveLength(0);
    expect(panel().textContent).toContain("Cloning repository");
  });

  it("shows the specific warning while keeping successful service destinations available", async () => {
    deployment.state.warningMessage = "The API domain is waiting for DNS verification.";
    deployment.state.serviceStatuses[2].status = "failed";
    await render();
    expect(host.querySelector("header")?.textContent).toContain(copy.status.readyWarnings);
    expect(host.textContent).toContain(deployment.state.warningMessage);
    const openSite = host.querySelector<HTMLButtonElement>(`button[aria-label="${copy.openSite}"]`)!;
    await act(async () => openSite.click());
    expect([...host.querySelectorAll('nav a[target="_blank"]')].map(link => link.getAttribute("href"))).toEqual(["https://api.clinicai.example", "https://clinicai.example"]);
  });
});
