// @vitest-environment happy-dom
import { act, createContext, useContext, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
import { DEFAULT_CONFIG, type DeploymentConfig } from "@/context/deployment/types";
import { baseDictionary } from "@/i18n";
import ComposeServices from "./ComposeServices";
import { serviceEnvironmentChanges } from "@/lib/service-environment-editor";

const TestDeployment = createContext<any>(null);
const h = vi.hoisted(() => ({
  config: {} as DeploymentConfig,
  value: {} as any,
  get: vi.fn(),
  reveal: vi.fn(),
}));
vi.mock("@/context/DeploymentContext", () => ({
  useDeployment: () => useContext(TestDeployment),
  useOptionalDeployment: () => undefined,
}));
vi.mock("@/context/PlatformContext", () => ({
  usePlatform: () => ({ baseDomain: "example.test" }),
}));
vi.mock("@/lib/api/services", () => ({
  servicesApi: { getEnvironment: h.get, revealEnv: h.reveal },
}));
vi.mock("@/components/ui/Modal", () => ({
  Modal: ({ children, isOpen }: { children: ReactNode; isOpen: boolean }) =>
    isOpen ? children : null,
}));
vi.mock("@/lib/demo-mode", () => ({ useDemoMode: () => false }));

const response = () => ({
  success: true,
  environment: {
    environment: "production",
    status: "unchecked",
    missingRequired: [],
    changedKeys: [],
    recoverableKeys: [],
    variables: [
      { key: "BASE_URL", value: "https://console.example.com", isSecret: false, source: "compose" },
      {
        key: "POSTGRES_DB",
        value: "customer-database",
        isSecret: false,
        source: "service",
        sourceId: "env-db",
      },
      { key: "PORT", value: "8787", isSecret: false, source: "generated" },
    ],
  },
});
let host: HTMLDivElement;
let root: Root;
function Harness() {
  const [config, setConfig] = useState(h.config);
  h.config = config;
  h.value = {
    config,
    updateConfig: (patch: Partial<DeploymentConfig>) =>
      setConfig((before) => ({ ...before, ...patch })),
  };
  return (
    <TestDeployment.Provider value={h.value}>
      <I18nProvider>
        <ComposeServices />
      </I18nProvider>
    </TestDeployment.Provider>
  );
}
async function open() {
  const button = [...host.querySelectorAll("button")].find((node) =>
    node.textContent?.includes(baseDictionary.importProject.composeServices.card.envVars),
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
}
function field(key: string) {
  const name = [...host.querySelectorAll<HTMLInputElement>("input")].find(
    (input) => input.value === key,
  );
  expect(name).toBeDefined();
  return name!.closest("[data-env-index]")!.querySelectorAll<HTMLInputElement>("input")[1]!;
}
async function enter(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.get.mockResolvedValue(response());
  h.config = {
    ...structuredClone(DEFAULT_CONFIG),
    projectId: "project-1",
    projectName: "Application",
    projectType: "services",
    serviceDeploymentMode: "services",
    services: [
      {
        name: "console",
        serviceId: "svc-console",
        image: "node:22",
        ports: [],
        volumes: [],
        dependsOn: [],
        environment: {
          BASE_URL: "${BASE_URL:-https://console.example.com}",
          POSTGRES_DB: "${POSTGRES_DB:-application}",
        },
        advanced: { environmentTemplateKeys: ["BASE_URL", "POSTGRES_DB"] },
      },
    ],
  };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<Harness />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("saved service environment in the wizard", () => {
  it("loads the same effective service overrides and defaults on demand, without a runtime inspection", async () => {
    expect(h.get).not.toHaveBeenCalled();
    await open();
    expect(h.get).toHaveBeenCalledExactlyOnceWith("project-1", "svc-console");
    expect(field("BASE_URL").value).toBe("https://console.example.com");
    expect(field("POSTGRES_DB").value).toBe("customer-database");
    expect(field("PORT").value).toBe("8787");
    await enter(field("POSTGRES_DB"), "edited-database");
    const service = h.config.services[0]!;
    expect(service.environment.POSTGRES_DB).toBe("${POSTGRES_DB:-application}");
    expect(service.environmentDraft?.rows.find((row) => row.key === "POSTGRES_DB")?.value).toBe(
      "edited-database",
    );
    expect(h.reveal).not.toHaveBeenCalled();
  });

  it("keeps a removed override removed when editing another variable", async () => {
    await open();
    const row = field("POSTGRES_DB").closest("[data-env-index]")!;
    const remove = [...row.querySelectorAll("button")].find(
      (button) =>
        button.title ===
        baseDictionary.projectDetail.services.detail.environmentState.removeOverride,
    )!;
    expect(remove).toBeDefined();
    await act(async () => remove.click());
    await enter(field("BASE_URL"), "https://changed.example.com");
    const draft = h.config.services[0]!.environmentDraft!;
    expect(serviceEnvironmentChanges(draft.baseline, draft.rows)).toMatchObject({
      deletes: [{ key: "POSTGRES_DB", sourceId: "env-db" }],
      upserts: [{ key: "BASE_URL", value: "https://changed.example.com", sourceId: null }],
    });
    expect(draft.rows.some((row) => row.key === "POSTGRES_DB")).toBe(false);
  });

  it("shows a read failure and retry instead of editable guessed defaults", async () => {
    h.get.mockRejectedValueOnce(new Error("Connection lost"));
    await open();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Connection lost");
    expect(host.querySelector("[data-env-index]")).toBeNull();
    const retry = [...host.querySelectorAll("button")].find(
      (node) =>
        node.textContent === baseDictionary.projectDetail.services.detail.environmentState.reload,
    )!;
    await act(async () => retry.click());
    expect(field("POSTGRES_DB").value).toBe("customer-database");
    expect(h.get).toHaveBeenCalledTimes(2);
  });

  it("discards a late read when the environment dialog is closed", async () => {
    let finish!: (value: ReturnType<typeof response>) => void;
    h.get.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await open();
    const close = host.querySelector<HTMLButtonElement>(
      `[aria-label="${baseDictionary.importProject.composeServices.card.closeEnv}"]`,
    )!;
    await act(async () => close.click());
    await act(async () => finish(response()));
    expect(h.config.services[0]!.environmentDraft).toBeUndefined();
  });
});
