// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseDictionary } from "@/i18n";
import { DeploymentContext } from "@/context/DeploymentContext";
import {
  DEFAULT_CONFIG,
  type DeploymentConfig,
  type DeploymentContextType,
} from "@/context/deployment/types";
import DeployTargetStep from "@/app/(dashboard)/(deployment)/deploy/[slug]/components/DeployTargetStep";
import BuildSummary from "@/app/(dashboard)/(deployment)/deploy/[slug]/components/BuildSummary";
import type { ServerSelection } from "@/components/shared/ServerSelector";
import type { ServerRuntimeSelection } from "@/app/(dashboard)/(deployment)/deploy/[slug]/components/ServerRuntimePicker";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
vi.mock("@/components/i18n-provider", () => ({
  useI18n: () => ({ t: baseDictionary }),
  interpolate: (text: string, values: Record<string, string>) =>
    text.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? key),
}));
vi.mock("@/context/PlatformContext", () => ({
  usePlatform: () => ({ selfHosted: true, deployMode: "desktop", baseDomain: "example.test" }),
}));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("@/components/shared/ServerSelector", () => ({ ServerSelectorView: () => null }));
vi.mock("@/app/(dashboard)/(deployment)/deploy/[slug]/components/ServerRuntimePicker", () => ({
  default: () => null,
}));
vi.mock("@/app/(dashboard)/(deployment)/deploy/[slug]/components/RollbackBackupPanel", () => ({
  RollbackBackupPanel: () => null,
}));
vi.mock("@/components/deploy/ResourceTierPicker", () => ({
  ResourceTierPicker: () => null,
  useResourceTierLabels: () => ({ name: (tier: string) => tier }),
}));
vi.mock("@/components/project-settings/CloudStaticHosting", () => ({
  CloudStaticHosting: () => null,
}));

let host: HTMLDivElement;
let root: Root;
let config: DeploymentConfig;
const updateConfig = vi.fn<DeploymentContextType["updateConfig"]>();
const selection = {
  ready: true,
  loading: false,
  selected: { name: "Production" },
} as ServerSelection;
const copy = baseDictionary.deploy.targetStep;

beforeEach(() => {
  config = {
    ...DEFAULT_CONFIG,
    options: { ...DEFAULT_CONFIG.options },
    projectId: "existing",
    deployTarget: "server",
    serverId: "server-a",
    buildStrategy: "local",
    runtimeMode: "docker",
  };
  updateConfig.mockReset();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
async function render(
  children: ReactNode = (
    <DeployTargetStep
      serverSelection={selection}
      runtimeSelection={{} as ServerRuntimeSelection}
      onContinue={() => {}}
      onBack={() => {}}
    />
  ),
) {
  await act(async () =>
    root.render(
      <DeploymentContext.Provider
        value={
          {
            config,
            updateConfig: (updates: Partial<DeploymentConfig>) => updateConfig(updates),
          } as DeploymentContextType
        }
      >
        {children}
      </DeploymentContext.Provider>,
    ),
  );
}
function option(value: string) {
  return host.querySelector<HTMLButtonElement>(`button[value="${value}"]`);
}

describe("build-location controls", () => {
  it("hides unsupported local image builds and preserves a legacy local clone", async () => {
    await render();
    expect(host.textContent).not.toContain(copy.build.localLabel);
    expect(host.textContent).toContain(copy.clone.heading);
    expect(option("api-host")?.getAttribute("aria-pressed")).toBe("true");
    expect(updateConfig).not.toHaveBeenCalled();
    await act(async () => option("server")!.click());
    expect(updateConfig).toHaveBeenCalledExactlyOnceWith({ cloneStrategy: "server" });
    expect(config.buildStrategy).toBe("local");
  });
  it("keeps both bare build choices in the destination editor", async () => {
    config.runtimeMode = "bare";
    await render();
    expect(host.textContent).toContain(copy.build.localLabel);
    expect(host.textContent).toContain(copy.build.remoteLabel);
    expect(host.textContent).not.toContain(copy.clone.heading);
    await act(async () => option("server")!.click());
    expect(updateConfig).toHaveBeenCalledExactlyOnceWith({ buildStrategy: "server" });
  });
  it("does not offer local builds for static server output served as bare files", async () => {
    config.runtimeMode = "bare";
    config.options = { ...config.options, workloadType: "static", hasServer: false };
    await render();
    expect(host.textContent).not.toContain(copy.build.localLabel);
    expect(host.textContent).toContain(copy.clone.heading);
  });
  it("does not offer or label local building for a managed Cloud destination", async () => {
    config.deployTarget = "cloud";
    config.runtimeMode = "bare";
    await render();
    expect(host.textContent).not.toContain(copy.build.localLabel);
    expect(host.textContent).not.toContain(baseDictionary.deploy.summary.buildLocal);
    expect(host.textContent).toContain(baseDictionary.deploy.summary.buildAndDeploy);
    expect(updateConfig).not.toHaveBeenCalled();
  });
  it("keeps explicit clone choices and seeds only an unset new-project choice", async () => {
    config.projectId = undefined;
    config.cloneStrategy = "server";
    await render();
    expect(option("server")?.getAttribute("aria-pressed")).toBe("true");
    expect(updateConfig).not.toHaveBeenCalled();
    config = { ...config, cloneStrategy: undefined };
    await render();
    expect(updateConfig).toHaveBeenCalledExactlyOnceWith({ cloneStrategy: "api-host" });
  });
  it("uses the same actual location in the build summary", async () => {
    await render(<BuildSummary />);
    expect(host.textContent).toContain(baseDictionary.deploy.buildSummary.server);
    expect(host.textContent).not.toContain(baseDictionary.deploy.buildSummary.localMachine);
    config = { ...config, runtimeMode: "bare" };
    await render(<BuildSummary />);
    expect(host.textContent).toContain(baseDictionary.deploy.buildSummary.localMachine);
  });
  it("preserves enabled monorepo app and public-service counts from main", async () => {
    config.projectType = "monorepo";
    config.serviceDeploymentMode = "services";
    config.monorepoApps = [
      { enabled: true, exposed: true },
      { enabled: true, exposed: false },
      { enabled: false, exposed: true },
    ] as DeploymentConfig["monorepoApps"];
    await render(<BuildSummary />);
    expect(host.textContent).toContain(
      baseDictionary.deploy.buildSummary.servicesValue
        .replace("{total}", "2")
        .replace("{exposed}", "1"),
    );
  });
});
