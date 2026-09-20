// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
import { ModalProvider } from "@/context/ModalContext";
import { ApiError } from "@/lib/api/client";
import { parseDotenv } from "@/lib/dotenv";
import { baseDictionary } from "@/i18n";
import { ServiceDetailPanel } from "./ServiceDetailPanel";

const mocks = vi.hoisted(() => ({
  getEnv: vi.fn(), setEnv: vi.fn(), restart: vi.fn(), post: vi.fn(),
  push: vi.fn(), toast: vi.fn(), invalidate: vi.fn(), pricing: vi.fn(), refresh: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ showToast: mocks.toast }) }));
vi.mock("@/context/PlatformContext", () => ({ usePlatform: () => ({ baseDomain: "example.test" }) }));
vi.mock("@/components/theme-provider", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("@/hooks/useLocalhostForward", () => ({ useLocalhostForward: () => ({ canForward: false }) }));
vi.mock("@/hooks/useProjectEndpoints", () => ({ invalidateProjectCaches: mocks.invalidate }));
vi.mock("@/hooks/useCloudDeployPricing", () => ({ useCloudDeployPricing: () => mocks.pricing }));
vi.mock("@/lib/api/client", async (original) => {
  const actual = await original<typeof import("@/lib/api/client")>();
  return { ...actual, api: { ...actual.api, post: mocks.post } };
});
vi.mock("@/lib/api/services", async (original) => {
  const actual = await original<typeof import("@/lib/api/services")>();
  return { ...actual, servicesApi: { ...actual.servicesApi,
    getEnv: mocks.getEnv, setEnv: mocks.setEnv, restart: mocks.restart,
  } };
});
vi.mock("@/lib/api/projects", () => ({ projectsApi: { getEnv: async () => ({ data: [] }) } }));
vi.mock("@/lib/api", async (original) => {
  const actual = await original<typeof import("@/lib/api")>();
  return { ...actual, backupsApi: { ...actual.backupsApi, listPolicies: async () => ({ data: [] }) } };
});
// Unrelated settings and sharing panels do not participate in this flow.
vi.mock("./ServiceSettingsForm", () => ({ ServiceSettingsForm: () => null }));
vi.mock("../UseInProjectModal", () => ({ UseInProjectModal: () => null }));
vi.mock("../UsedByCard", () => ({ UsedByCard: () => null }));

type Props = ComponentProps<typeof ServiceDetailPanel>;
const service: Props["service"] = {
  id: "svc-api", name: "api", kind: "compose", enabled: true,
  image: "example/api:current", build: ".", ports: [], volumes: [],
  dockerfile: null, buildArgs: null, dependsOn: [], environment: null,
  command: null, restart: null, exposed: false, exposedPort: null,
  domain: null, customDomain: null, domainType: null, sortOrder: 0,
};
const copy = baseDictionary.projectDetail.services.detail;
const savedEnv = [
  { id: "billing-flag", key: "BILLING_ENABLED", value: "false", isSecret: false },
  { id: "saved-secret", key: "TOKEN", value: "••••••••", isSecret: true },
];
const applied = { success: true, containerId: "new-api" };
const stale = () => new ApiError(409, "Conflict", {
  code: "SERVICE_CONFIG_STALE", staleEnvKeys: ["BILLING_ENABLED"], serviceName: "api",
  error: 'Raw instructions: POST /api/deployments; restart with force=true',
});
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.getEnv.mockResolvedValue({ success: true, vars: savedEnv });
  mocks.setEnv.mockResolvedValue({ success: true });
  mocks.restart.mockResolvedValue({ success: true });
  mocks.post.mockResolvedValue(applied);
  mocks.pricing.mockReturnValue(false);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  if (vi.isFakeTimers()) await vi.runOnlyPendingTimersAsync();
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function render(tab = "env", extra: Partial<Props> = {}) {
  await act(async () => root.render(
    <I18nProvider><ModalProvider>
      <ServiceDetailPanel
        service={service} projectId="project-stack" projectSlugBase="stack"
        activeDeploymentId="current" projectType="services" initialTab={tab}
        container={{
          serviceId: service.id, serviceName: service.name,
          containerId: "running-api", status: "running", ip: null,
          hostPort: null, imageRef: service.image,
        }}
        onRefresh={mocks.refresh} deepLink={false} {...extra}
      />
    </ModalProvider></I18nProvider>,
  ));
}
function button(label: string) {
  const found = [...document.querySelectorAll("button")].find((item) => item.getAttribute("aria-label") === label || item.textContent?.trim() === label);
  expect(found, `button ${label}`).toBeDefined();
  return found!;
}
async function click(label: string) {
  await act(async () => button(label).click());
}
async function editFlag(value: string) {
  const input = [...host.querySelectorAll("input")].find((item) => item.value === "false")!;
  expect(input).toBeDefined();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function expectServiceApply() {
  expect(mocks.post).toHaveBeenCalledExactlyOnceWith(
    "projects/project-stack/services/svc-api/apply-env", undefined, { timeout: 120_000 },
  );
  expect(mocks.push).not.toHaveBeenCalled();
  expect(mocks.invalidate).toHaveBeenCalledWith("project-stack");
  expect(mocks.refresh).toHaveBeenCalledOnce();
  expect(mocks.toast).toHaveBeenCalledWith(copy.environmentApply.applied, "success", "api");
}

describe("service environment apply", () => {
  it("downloads this service's production values through the existing reveal endpoint in one click", async () => {
    vi.useFakeTimers();
    const createObjectURL = vi.fn<(blob: Blob) => string>(() => "blob:production-env");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", class extends URL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = revokeObjectURL;
    });
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const secret = "user's${TOKEN} \"saved-secret\"\r\nlast";
    mocks.post.mockResolvedValueOnce({ success: true, environment: { TOKEN: secret } });
    await render();
    expect(mocks.getEnv).toHaveBeenCalledWith("project-stack", "svc-api", "production");
    await click(baseDictionary.importProject.environmentVariables.downloadEnv);
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith("projects/project-stack/services/svc-api/env-reveal", {
      keys: ["TOKEN"], environment: "production",
    });
    expect(anchorClick).toHaveBeenCalledOnce();
    const blob = createObjectURL.mock.calls[0]![0];
    expect(parseDotenv(await blob.text())).toEqual([
      { key: "BILLING_ENABLED", value: "false" }, { key: "TOKEN", value: secret },
    ]);
    expect(host.textContent).not.toContain("saved-secret");
    expect([...host.querySelectorAll("input")].some(input => input.value.includes("saved-secret"))).toBe(false);
    expect(mocks.setEnv).not.toHaveBeenCalled();
    expect(mocks.restart).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("saves edits before applying only the selected service without resending secrets or opening a build", async () => {
    await render();
    await editFlag("true");
    expect(button(copy.environmentApply.title).disabled).toBe(true);
    expect(button(copy.environmentApply.title).title).toBe(copy.environmentApply.saveFirst);
    mocks.getEnv.mockResolvedValue({ success: true, vars: [
      { ...savedEnv[0], value: "true" }, savedEnv[1],
    ] });
    await click(copy.saveEnvironment);
    expect(mocks.setEnv).toHaveBeenCalledWith("project-stack", "svc-api", {
      environment: "production",
      vars: [
        { sourceId: "billing-flag", key: "BILLING_ENABLED", value: "true", isSecret: false },
        { sourceId: "saved-secret", key: "TOKEN", value: "••••••••", isSecret: true },
      ],
    });
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith("Environment saved", "success", "api");
    expect(button(copy.environmentApply.title).disabled).toBe(false);
    await click(copy.environmentApply.title);
    expectServiceApply();
    expect(mocks.restart).not.toHaveBeenCalled();
  });

  it("opens the Environment panel after a refused restart and waits for Apply", async () => {
    mocks.restart.mockRejectedValue(stale());
    await render("settings");
    expect(host.textContent).not.toContain(copy.environmentApply.title);
    await click(copy.restart);
    expect(document.body.textContent).not.toContain("force=true");
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("api has saved environment changes"), "info", "api");
    expect(mocks.post).not.toHaveBeenCalled();
    expect(button(copy.saveEnvironment)).toBeDefined();
    await click(copy.environmentApply.title);
    expectServiceApply();
    expect(mocks.restart.mock.calls).toEqual([
      ["project-stack", "svc-api"],
    ]);
  });

  it("applies from Environment once and disables lifecycle actions while the request is pending", async () => {
    let release!: (value: unknown) => void;
    mocks.post.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    await render("env");
    const apply = button(copy.environmentApply.title);
    await act(async () => { apply.click(); apply.click(); });
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(button(copy.environmentApply.applying).disabled).toBe(true);
    expect(button(copy.saveEnvironment).disabled).toBe(true);
    await click(copy.tabs.settings);
    expect(host.textContent).not.toContain(copy.environmentApply.title);
    expect(host.textContent).not.toContain(copy.environmentApply.applying);
    expect(button(copy.restart).disabled).toBe(true);
    expect(button(copy.stop).disabled).toBe(true);
    expect(mocks.push).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalledWith(copy.environmentApply.applied, expect.anything(), expect.anything());
    expect(mocks.invalidate).not.toHaveBeenCalled();
    await act(async () => release(applied));
    expectServiceApply();
  });

  it("keeps saved variables and the apply action available when applying is refused", async () => {
    const denied = new ApiError(403, "Forbidden", { error: "You cannot deploy this project" });
    mocks.post.mockRejectedValueOnce(denied);
    await render();
    await click(copy.environmentApply.title);
    expect(mocks.toast).toHaveBeenCalledWith("You cannot deploy this project", "error", "api");
    expect(mocks.push).not.toHaveBeenCalled();
    expect(mocks.invalidate).not.toHaveBeenCalled();
    expect(host.querySelector('input[value="BILLING_ENABLED"]')).not.toBeNull();
    expect(button(copy.environmentApply.title).disabled).toBe(false);
    await click(copy.environmentApply.title);
    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(mocks.push).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(copy.environmentApply.applied, "success", "api");
  });

  it("uses the Cloud purchase flow only when an explicit apply is blocked by billing", async () => {
    const blocked = new ApiError(402, "Payment Required", { code: "CLOUD_BILLING_BLOCKED" });
    mocks.post.mockRejectedValue(blocked);
    mocks.pricing.mockReturnValue(true);
    await render();
    expect(mocks.pricing).not.toHaveBeenCalled();
    await click(copy.environmentApply.title);
    expect(mocks.pricing).toHaveBeenCalledExactlyOnceWith(blocked);
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("does not convert an unrelated restart error into a deployment", async () => {
    mocks.restart.mockRejectedValue(new ApiError(403, "Forbidden", { error: "Not allowed" }));
    await render("settings");
    await click(copy.restart);
    expect(mocks.toast).toHaveBeenCalledWith("Not allowed", "error", "api");
    expect(host.textContent).not.toContain(copy.environmentApply.title);
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("keeps a normal restart as a restart when no saved changes are pending", async () => {
    await render("settings");
    await click(copy.restart);
    expect(mocks.restart).toHaveBeenCalledExactlyOnceWith("project-stack", "svc-api");
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("preserves unsaved editor changes when Restart detects older saved changes", async () => {
    mocks.restart.mockRejectedValue(stale());
    await render();
    await editFlag("true");
    await click(copy.tabs.settings);
    await click(copy.restart);
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(copy.environmentApply.saveFirst, "info", "api");
    expect([...host.querySelectorAll("input")].some((input) => input.value === "true")).toBe(true);
    expect(button(copy.saveEnvironment).disabled).toBe(false);
  });

  it.each([
    { activeDeploymentId: null, container: undefined },
    { service: { ...service, enabled: false } },
  ])("keeps Apply visible with a reason when the service cannot be refreshed", async (props) => {
    await render("env", props);
    expect(button(copy.environmentApply.title).disabled).toBe(true);
    expect(button(copy.environmentApply.title).title).toBe(
      props.service ? copy.toast.enableBeforeRedeploy : copy.toast.deployFirstRedeploy,
    );
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it.each([null, undefined])("lets the API resolve the deployment when the panel has only a live container (%s)", async (activeDeploymentId) => {
    await render("env", { activeDeploymentId });
    expect(button(copy.environmentApply.title).disabled).toBe(false);
    expect(button(copy.environmentApply.title).title).toBe(copy.environmentApply.hint);
    await click(copy.environmentApply.title);
    expectServiceApply();
  });
});
