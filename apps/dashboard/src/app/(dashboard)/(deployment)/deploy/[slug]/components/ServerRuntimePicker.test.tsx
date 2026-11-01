// @vitest-environment happy-dom
import React, { act, type Dispatch, type SetStateAction } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
import { baseDictionary } from "@/i18n";
import { DEFAULT_CONFIG, type DeploymentConfig } from "@/context/deployment/types";
import ServerRuntimePicker, { useServerRuntimeSelection } from "./ServerRuntimePicker";

const h = vi.hoisted(() => ({
  initial: {} as DeploymentConfig,
  latest: {} as DeploymentConfig,
  stats: null as { memTotal: number } | null,
  setConfig: null as Dispatch<SetStateAction<DeploymentConfig>> | null,
}));
vi.mock("@/context/DeploymentContext", async () => {
  const { useCallback, useState } = await import("react");
  return { useDeployment: () => {
    const [config, setConfig] = useState(h.initial);
    h.latest = config;
    h.setConfig = setConfig;
    const updateConfig = useCallback((patch: Partial<DeploymentConfig>) => setConfig(previous => ({ ...previous, ...patch })), []);
    return { config, updateConfig };
  } };
});
vi.mock("@/hooks/useMonitorStream", () => ({ useMonitorStream: () => ({ stats: h.stats }) }));

let root: Root;
let host: HTMLDivElement;
const Wizard = ({ memoryMb, showPicker, enabled }: { memoryMb?: number; showPicker: boolean; enabled: boolean }) => {
  const selection = useServerRuntimeSelection({ memoryMb, enabled });
  return showPicker ? <ServerRuntimePicker selection={selection} /> : null;
};
const render = (memoryMb?: number, showPicker = true, enabled = true) => act(async () => root.render(
  <I18nProvider><Wizard memoryMb={memoryMb} showPicker={showPicker} enabled={enabled} /></I18nProvider>,
));
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.initial = { ...DEFAULT_CONFIG, projectType: "app", serverId: "server-a", deployTarget: "cloud" };
  h.stats = null;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("server runtime defaults", () => {
  it("selects Direct for a new single app on a small managed server before monitoring connects", async () => {
    await render(1536);
    expect(h.latest.runtimeMode).toBe("bare");
    expect(h.latest.runtimeModeExplicit).not.toBe(true);
  });
  it("uses the same default for a small connected server", async () => {
    h.initial.deployTarget = "server";
    h.stats = { memTotal: 1024 ** 3 };
    await render();
    expect(h.latest.runtimeMode).toBe("bare");
  });
  it("selects Direct on the configuration view without opening the destination editor", async () => {
    await render(1536, false);
    expect(host.textContent).toBe("");
    expect(h.latest.runtimeMode).toBe("bare");
  });
  it("waits until wizard hydration completes before applying the default", async () => {
    await render(1536, false, false);
    expect(h.latest.runtimeMode).toBe("docker");
    await render(1536, false);
    expect(h.latest.runtimeMode).toBe("bare");
  });
  it.each([undefined, 0, 2048, 4096])("keeps Docker when memory is unknown or at least 2 GiB (%s MiB)", async memory => {
    await render(memory);
    expect(h.latest.runtimeMode).toBe("docker");
  });
  it.each(["project", "explicit"])("preserves a %s Docker choice on a small server", async origin => {
    if (origin === "project") h.initial.projectId = "existing-project";
    else h.initial.runtimeModeExplicit = true;
    await render(1536);
    expect(h.latest.runtimeMode).toBe("docker");
  });
  it("does not change a user's choice when monitoring or the destination changes", async () => {
    await render(1536);
    const sandbox = [...host.querySelectorAll("button")].find(button =>
      button.textContent?.includes(baseDictionary.deploy.runtime.sandboxedLabel));
    expect(sandbox).toBeDefined();
    await act(async () => sandbox!.click());
    expect(h.latest).toMatchObject({ runtimeMode: "docker", runtimeModeExplicit: true });
    await act(async () => h.setConfig!(previous => ({ ...previous, serverId: "server-b" })));
    await render(1024);
    expect(h.latest.runtimeMode).toBe("docker");
  });
  it.each(["docker", "services", "monorepo"] as const)("does not select Bare for a %s deployment", async projectType => {
    h.initial.projectType = projectType;
    h.initial.serviceDeploymentMode = "services";
    await render(1536);
    expect(h.latest.runtimeMode).toBe("docker");
  });
});
