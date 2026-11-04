// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
import { ModalProvider } from "@/context/ModalContext";
import { ApiError } from "@/lib/api/client";
import { parseDotenv } from "@/lib/dotenv";
import { baseDictionary } from "@/i18n";
import type { ServiceEnvironment } from "@repo/contracts";
import { ServiceDetailPanel } from "./ServiceDetailPanel";

const mocks = vi.hoisted(() => ({
  getEnvironment: vi.fn(),
  mergeEnv: vi.fn(),
  reviewEnv: vi.fn(),
  restart: vi.fn(),
  post: vi.fn(),
  push: vi.fn(),
  toast: vi.fn(),
  invalidate: vi.fn(),
  pricing: vi.fn(),
  refresh: vi.fn(),
  update: vi.fn(),
  trigger: vi.fn(),
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
  return {
    ...actual,
    servicesApi: {
      ...actual.servicesApi,
      getEnvironment: mocks.getEnvironment,
      mergeEnv: mocks.mergeEnv,
      reviewEnv: mocks.reviewEnv,
      restart: mocks.restart,
      update: mocks.update,
    },
  };
});
vi.mock("@/lib/api/projects", () => ({ projectsApi: { getEnv: async () => ({ data: [] }) } }));
vi.mock("@/lib/api/deploy", async (original) => {
  const actual = await original<typeof import("@/lib/api/deploy")>();
  return { ...actual, deployApi: { ...actual.deployApi, trigger: mocks.trigger } };
});
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
function environmentState(
  vars: Array<{
    id?: string;
    key: string;
    value: string;
    isSecret: boolean;
    source?: "service" | "compose" | "project" | "generated";
  }> = savedEnv,
  status: ServiceEnvironment["status"] = "pending",
): { success: boolean; environment: ServiceEnvironment } {
  return {
    success: true,
    environment: {
      environment: "production",
      status,
      variables: vars.map((row) => ({
        key: row.key,
        value: row.value,
        isSecret: row.isSecret,
        source: row.source ?? "service",
        ...(row.id ? { sourceId: row.id } : {}),
      })),
      missingRequired: [],
      changedKeys: status === "pending" ? ["BILLING_ENABLED"] : [],
      recoverableKeys: [],
      containerId: "running-api",
    },
  };
}
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
  mocks.getEnvironment.mockResolvedValue(environmentState());
  mocks.mergeEnv.mockResolvedValue({ success: true });
  mocks.reviewEnv.mockResolvedValue({ revision: "a".repeat(64), changes: [] });
  mocks.restart.mockResolvedValue({ success: true });
  mocks.post.mockResolvedValue(applied);
  mocks.pricing.mockReturnValue(false);
  mocks.update.mockResolvedValue({ success: true });
  mocks.trigger.mockResolvedValue({ success: true, data: { deployment: { id: "dep-empty" } } });
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
  it("shows saved Compose variables when there are no service override rows", async () => {
    mocks.getEnvironment.mockResolvedValue(
      environmentState(
        [
          { key: "DATABASE_URL", value: "••••••••", isSecret: true, source: "compose" },
          { key: "PORT", value: "••••••••", isSecret: true, source: "compose" },
        ],
        "synced",
      ),
    );
    await render("env", {
      service: {
        ...service,
        environment: { DATABASE_URL: "••••••••", PORT: "••••••••" },
      },
    });

    const keys = [...host.querySelectorAll("input")].map((input) => input.value);
    expect(keys).toContain("DATABASE_URL");
    expect(keys).toContain("PORT");
    expect(host.textContent).not.toContain("No environment variables");
  });

  it("does not offer an actionable Apply when there is no environment change", async () => {
    mocks.getEnvironment.mockResolvedValue(environmentState([], "synced"));
    await render();
    const apply = [...host.querySelectorAll("button")].find(
      (item) => item.textContent?.trim() === copy.environmentApply.title,
    );
    expect(apply === undefined || apply.disabled).toBe(true);
  });

  it("saves an edited inherited value as one override and leaves all other saved values untouched", async () => {
    mocks.getEnvironment.mockResolvedValue(
      environmentState(
        [
          { key: "BILLING_ENABLED", value: "false", source: "project", isSecret: false },
          { key: "DATABASE_URL", value: "••••••••", source: "compose", isSecret: true },
        ],
        "synced",
      ),
    );
    await render();
    expect((host.querySelector('input[value="DATABASE_URL"]') as HTMLInputElement).readOnly).toBe(
      true,
    );
    await editFlag("true");
    await click(copy.saveEnvironment);
    expect(mocks.mergeEnv).toHaveBeenCalledExactlyOnceWith("project-stack", "svc-api", {
      environment: "production",
      upserts: [{ key: "BILLING_ENABLED", value: "true", isSecret: false, sourceId: null }],
      deletes: [],
    });
  });

  it("shows a loading failure rather than an empty environment and prevents saving", async () => {
    mocks.getEnvironment.mockRejectedValue(new Error("Cannot read saved configuration"));
    await render();
    expect(host.textContent).toContain("Cannot read saved configuration");
    expect(host.textContent).not.toContain("No environment variables");
    expect(button(copy.saveEnvironment).disabled).toBe(true);
    expect(host.textContent).not.toContain(copy.environmentApply.title);
    expect(mocks.mergeEnv).not.toHaveBeenCalled();
  });

  it.each([true, false])("reviews inherited edits before saving (shared: %s)", async (shared) => {
    mocks.getEnvironment.mockResolvedValue(environmentState([
      { key: "BILLING_ENABLED", value: "false", source: "project", isSecret: false },
    ], "synced"));
    mocks.reviewEnv.mockResolvedValue({ revision: "a".repeat(64), changes: [{
      key: "BILLING_ENABLED", projectKey: "BILLING_ENABLED",
      services: [{ id: service.id, name: "api", keys: ["BILLING_ENABLED"] }, { id: "worker", name: "Worker", keys: ["BILLING_ENABLED"] }],
    }] });
    mocks.mergeEnv.mockResolvedValue({ success: true, ...(shared ? { affectedServices: [{ id: "worker", name: "Worker" }] } : {}) });
    await render();
    await editFlag("true");
    await click(copy.saveEnvironment);
    expect(mocks.mergeEnv).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Worker");
    expect(document.body.textContent).toContain(copy.environmentState.shared.repositoryHint);
    await click(shared ? copy.environmentState.shared.updateSelected : copy.environmentState.shared.onlyService);
    expect(mocks.mergeEnv).toHaveBeenCalledExactlyOnceWith("project-stack", "svc-api", {
      environment: "production", deletes: [],
      upserts: [{ key: "BILLING_ENABLED", value: "true", isSecret: false, sourceId: null }],
      ...(shared ? { shared: { keys: ["BILLING_ENABLED"], revision: "a".repeat(64) } } : {}),
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    if (shared) expect(host.querySelector('a[href="/projects/project-stack/services/worker/env"]')).not.toBeNull();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("keeps the draft when shared review fails, without silently saving an override", async () => {
    mocks.getEnvironment.mockResolvedValue(environmentState([
      { key: "BILLING_ENABLED", value: "false", source: "project", isSecret: false },
    ], "synced"));
    mocks.reviewEnv.mockRejectedValue(new Error("Review unavailable"));
    await render();
    await editFlag("true");
    await click(copy.saveEnvironment);
    expect(mocks.mergeEnv).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith("Review unavailable", "error", "api");
    expect(button(copy.saveEnvironment).disabled).toBe(false);
    expect([...host.querySelectorAll("input")].some((input) => input.value === "true")).toBe(true);
  });

  it("preserves per-variable choices and the draft after a stale shared save", async () => {
    mocks.getEnvironment.mockResolvedValue(environmentState([
      { key: "BILLING_ENABLED", value: "false", source: "project", isSecret: false },
      { key: "FEATURE_ENABLED", value: "false", source: "project", isSecret: false },
    ], "synced"));
    mocks.reviewEnv.mockResolvedValue({ revision: "a".repeat(64), changes: ["BILLING_ENABLED", "FEATURE_ENABLED"].map(key => ({
      key, projectKey: key, services: [{ id: "worker", name: "Worker", keys: [key] }],
    })) });
    mocks.mergeEnv.mockRejectedValue(new ApiError(409, "Conflict", {
      code: "ENVIRONMENT_CHANGED", error: "Shared configuration changed. Review your changes again before saving.",
    }));
    await render();
    await editFlag("true");
    await editFlag("true");
    await click(copy.saveEnvironment);
    await click("FEATURE_ENABLED");
    expect(button("FEATURE_ENABLED").getAttribute("aria-checked")).toBe("false");
    await click(copy.environmentState.shared.updateSelected);
    expect(mocks.mergeEnv).toHaveBeenCalledExactlyOnceWith("project-stack", "svc-api", {
      environment: "production", deletes: [],
      upserts: ["BILLING_ENABLED", "FEATURE_ENABLED"].map(key => ({ key, value: "true", isSecret: false, sourceId: null })),
      shared: { keys: ["BILLING_ENABLED"], revision: "a".repeat(64) },
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect([...host.querySelectorAll("input")].filter(input => input.value === "true")).toHaveLength(2);
    expect(button(copy.saveEnvironment).disabled).toBe(false);
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("discards a shared review that finishes after switching services", async () => {
    mocks.getEnvironment.mockResolvedValue(environmentState([
      { key: "BILLING_ENABLED", value: "false", source: "project", isSecret: false },
    ], "synced"));
    let finish!: (value: unknown) => void;
    mocks.reviewEnv.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    await render();
    await editFlag("true");
    await click(copy.saveEnvironment);
    await render("env", { service: { ...service, id: "other", name: "Other" } });
    await act(async () => finish({ revision: "a".repeat(64), changes: [{ key: "BILLING_ENABLED", projectKey: "BILLING_ENABLED", services: [] }] }));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(mocks.mergeEnv).not.toHaveBeenCalled();
  });

  it("does not put the previous service's values into a new service when a save finishes late", async () => {
    await render();
    await editFlag("true");
    let finishSave!: (value: unknown) => void;
    mocks.mergeEnv.mockReturnValue(new Promise(resolve => { finishSave = resolve; }));
    await click(copy.saveEnvironment);
    mocks.getEnvironment.mockResolvedValue(environmentState([{ id: "worker-key", key: "WORKER_ENV", value: "worker", isSecret: false }], "synced"));
    await render("env", { service: { ...service, id: "svc-worker", name: "worker" } });
    await act(async () => finishSave({ success: true }));
    const keys = [...host.querySelectorAll('input[placeholder="KEY"]')].map(input => (input as HTMLInputElement).value);
    expect(keys).toEqual(["WORKER_ENV"]);
    expect(button(copy.saveEnvironment).disabled).toBe(true);
    expect(mocks.mergeEnv.mock.calls[0]!.slice(0, 2)).toEqual(["project-stack", "svc-api"]);
  });

  it("shows saved values while Docker is offline and allows editing without claiming they are applied", async () => {
    mocks.getEnvironment.mockImplementation(async (_project, _service, input) => {
      if (input?.inspectRuntime) throw new Error("SSH unavailable");
      return environmentState(savedEnv, "unchecked");
    });
    await render();
    expect(host.textContent).toContain("SSH unavailable");
    expect(host.querySelector('input[value="TOKEN"]')).not.toBeNull();
    expect(host.textContent).not.toContain(copy.environmentApply.title);
    await editFlag("true");
    expect(button(copy.saveEnvironment).disabled).toBe(false);
    expect(button(copy.environmentApply.title).disabled).toBe(true);
  });

  it("requires recovery or explicit removal before applying runtime-only variables to an empty saved environment", async () => {
    const response = environmentState([], "pending");
    response.environment.recoverableKeys = ["LOST_TOKEN"];
    response.environment.changedKeys = ["LOST_TOKEN"];
    mocks.getEnvironment.mockResolvedValue(response);
    mocks.post.mockResolvedValue({
      success: true,
      environment: { LOST_TOKEN: "recover-this-value" },
    });
    await render();
    expect(button(copy.environmentApply.title).disabled).toBe(true);
    await click(copy.environmentState.recover);
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith(
      "projects/project-stack/services/svc-api/env-reveal",
      {
        keys: ["LOST_TOKEN"],
        environment: "production",
        source: "runtime",
        containerId: "running-api",
      },
    );
    expect(mocks.mergeEnv).not.toHaveBeenCalled();
    const value = host.querySelector('input[value="recover-this-value"]') as HTMLInputElement;
    expect(value.type).toBe("password");
    expect(button(copy.environmentApply.title).disabled).toBe(true);
    await click(copy.saveEnvironment);
    expect(mocks.mergeEnv).toHaveBeenCalledWith("project-stack", "svc-api", {
      environment: "production",
      upserts: [{ key: "LOST_TOKEN", value: "recover-this-value", sourceId: null, isSecret: true }],
      deletes: [],
    });
  });

  it("clears the missing badge when a required value is entered, then saves that value", async () => {
    const response = environmentState(
      [{ key: "DATABASE_PASSWORD", value: "", isSecret: true, source: "compose" }],
      "unavailable",
    );
    response.environment.missingRequired = ["DATABASE_PASSWORD"];
    Object.assign(response.environment.variables[0]!, { missing: true });
    mocks.getEnvironment.mockResolvedValue(response);
    await render();
    const value = host.querySelector('input[type="password"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        value,
        "new-value",
      );
      value.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(host.textContent).not.toContain("1 missing");
    await click(copy.saveEnvironment);
    expect(mocks.mergeEnv).toHaveBeenCalledWith("project-stack", "svc-api", {
      environment: "production",
      upserts: [{ key: "DATABASE_PASSWORD", value: "new-value", sourceId: null, isSecret: true }],
      deletes: [],
    });
  });

  it("uses the returned environment scope for saves and reveals", async () => {
    const response = environmentState();
    response.environment.environment = "preview";
    mocks.getEnvironment.mockResolvedValue(response);
    mocks.post.mockResolvedValue({ success: true, environment: { TOKEN: "preview-secret" } });
    await render();
    expect(mocks.getEnvironment).toHaveBeenCalledWith("project-stack", "svc-api", {
      environment: "preview",
      inspectRuntime: true,
    });
    await editFlag("true");
    await click(copy.saveEnvironment);
    expect(mocks.mergeEnv.mock.calls[0]![2].environment).toBe("preview");
    await click(baseDictionary.projectSettings.envVars.showValue);
    expect(mocks.post.mock.calls[0]![1]).toMatchObject({
      environment: "preview",
      source: "effective",
    });
  });

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
    expect(mocks.getEnvironment).toHaveBeenCalledWith("project-stack", "svc-api");
    await click(baseDictionary.importProject.environmentVariables.downloadEnv);
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith(
      "projects/project-stack/services/svc-api/env-reveal",
      {
        keys: ["TOKEN"],
        environment: "production",
        source: "effective",
      },
    );
    expect(anchorClick).toHaveBeenCalledOnce();
    const blob = createObjectURL.mock.calls[0]![0];
    expect(parseDotenv(await blob.text())).toEqual([
      { key: "BILLING_ENABLED", value: "false" }, { key: "TOKEN", value: secret },
    ]);
    expect(host.textContent).not.toContain("saved-secret");
    expect([...host.querySelectorAll("input")].some(input => input.value.includes("saved-secret"))).toBe(false);
    expect(mocks.mergeEnv).not.toHaveBeenCalled();
    expect(mocks.restart).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("saves edits before applying only the selected service without resending secrets or opening a build", async () => {
    await render();
    await editFlag("true");
    expect(button(copy.environmentApply.title).disabled).toBe(true);
    expect(button(copy.environmentApply.title).title).toBe(copy.environmentApply.saveFirst);
    mocks.getEnvironment.mockResolvedValue(
      environmentState([{ ...savedEnv[0]!, value: "true" }, savedEnv[1]!]),
    );
    await click(copy.saveEnvironment);
    expect(mocks.mergeEnv).toHaveBeenCalledWith("project-stack", "svc-api", {
      environment: "production",
      upserts: [
        { sourceId: "billing-flag", key: "BILLING_ENABLED", value: "true", isSecret: false },
      ],
      deletes: [],
    });
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith("Environment saved", "success", "api");
    expect(button(copy.environmentApply.title).disabled).toBe(false);
    await click(copy.environmentApply.title);
    expectServiceApply();
    expect(mocks.restart).not.toHaveBeenCalled();
  });

  it("does not redisplay the old revealed value after saving a secret", async () => {
    await render();
    mocks.post.mockResolvedValueOnce({
      success: true,
      environment: { TOKEN: "old-token" },
    });
    await click(baseDictionary.projectSettings.envVars.showValue);
    const input = host.querySelector(
      'input[value="old-token"]',
    ) as HTMLInputElement;
    expect(input.type).toBe("text");
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "new-token");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(input.value).toBe("new-token");
    await click(copy.saveEnvironment);
    expect(mocks.mergeEnv).toHaveBeenCalledWith("project-stack", "svc-api", {
      environment: "production",
      upserts: [
        {
          key: "TOKEN",
          value: "new-token",
          isSecret: true,
          sourceId: "saved-secret",
        },
      ],
      deletes: [],
    });
    expect(
      [...host.querySelectorAll("input")].map((item) => item.value),
    ).not.toContain("old-token");
    mocks.post.mockResolvedValueOnce({
      success: true,
      environment: { TOKEN: "new-token" },
    });
    await click(baseDictionary.projectSettings.envVars.showValue);
    expect(host.querySelector('input[value="new-token"]')).not.toBeNull();
    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(button(copy.saveEnvironment).disabled).toBe(true);
  });

  it("ignores a reveal started before a value was edited and saved", async () => {
    await render();
    let finishReveal!: (value: unknown) => void;
    mocks.post.mockReturnValueOnce(
      new Promise((resolve) => {
        finishReveal = resolve;
      }),
    );
    await click(baseDictionary.projectSettings.envVars.showValue);
    const input = host.querySelector(
      'input[value="••••••••"]',
    ) as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "new-token");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(copy.saveEnvironment);
    let finishCurrentReveal!: (value: unknown) => void;
    mocks.post.mockReturnValueOnce(
      new Promise((resolve) => {
        finishCurrentReveal = resolve;
      }),
    );
    await click(baseDictionary.projectSettings.envVars.showValue);
    await act(async () =>
      finishReveal({ success: true, environment: { TOKEN: "old-token" } }),
    );
    expect(
      [...host.querySelectorAll("input")].map((item) => item.value),
    ).not.toContain("old-token");
    expect(
      button(baseDictionary.projectSettings.envVars.showValue).disabled,
    ).toBe(true);
    await act(async () =>
      finishCurrentReveal({ success: true, environment: { TOKEN: "new-token" } }),
    );
    expect(host.querySelector('input[value="new-token"]')).not.toBeNull();
    expect(button(copy.saveEnvironment).disabled).toBe(true);
    expect(mocks.toast).not.toHaveBeenCalledWith(
      expect.anything(),
      "error",
      expect.anything(),
    );
  });

  it("keeps an untouched secret revealed when another variable is edited", async () => {
    await render();
    mocks.post.mockResolvedValueOnce({
      success: true,
      environment: { TOKEN: "saved-token" },
    });
    await click(baseDictionary.projectSettings.envVars.showValue);
    await editFlag("true");
    expect(host.querySelector('input[value="saved-token"]')).not.toBeNull();
    mocks.getEnvironment.mockResolvedValue(
      environmentState([{ ...savedEnv[0]!, value: "true" }, savedEnv[1]!]),
    );
    await click(copy.saveEnvironment);
    expect(host.querySelector('input[value="saved-token"]')).not.toBeNull();
    expect(mocks.post).toHaveBeenCalledOnce();
    expect(mocks.mergeEnv.mock.calls[0]![2].upserts).toEqual([
      {
        sourceId: "billing-flag",
        key: "BILLING_ENABLED",
        value: "true",
        isSecret: false,
      },
    ]);
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
    expect(button(copy.environmentApply.applying).closest("[hidden]")).not.toBeNull();
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

  it("disables Apply with a reason for a disabled service", async () => {
    await render("env", { service: { ...service, enabled: false } });
    expect(button(copy.environmentApply.title).disabled).toBe(true);
    expect(button(copy.environmentApply.title).title).toBe(copy.toast.enableBeforeRedeploy);
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("explains an undeployed environment without offering Apply", async () => {
    mocks.getEnvironment.mockResolvedValue(environmentState(savedEnv, "not-deployed"));
    await render("env", { activeDeploymentId: null, container: undefined });
    expect(host.textContent).not.toContain(copy.environmentApply.title);
    expect(host.textContent).toContain(copy.environmentState.status["not-deployed"]);
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


describe("empty storage through the service deployment flow", () => {
  async function prepare() {
    await render("volumes", { service: { ...service, volumes: ["original:/data", "shared:/shared:ro"] }, deployTarget: "cloud" });
    await click(copy.storage.emptyVolume.menu);
    await click(copy.storage.emptyVolume.title);
    const input = document.querySelector<HTMLInputElement>("[data-modal-layer] input")!;
    expect(input).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "api");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  it("saves a fresh named volume before deploying only this service", async () => {
    await prepare(); await click(copy.storage.emptyVolume.action);
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith("project-stack", "svc-api", {
      volumes: [expect.stringMatching(/^openship-fresh-[a-f0-9-]+:\/data$/), "shared:/shared:ro"],
    });
    expect(mocks.trigger).toHaveBeenCalledExactlyOnceWith({ projectId: "project-stack", serviceIds: ["svc-api"] });
    expect(mocks.update.mock.invocationCallOrder[0]).toBeLessThan(mocks.trigger.mock.invocationCallOrder[0]!);
    expect(mocks.push).toHaveBeenCalledWith("/build/dep-empty");
  });
  it("does not deploy if saving the new mount fails", async () => {
    mocks.update.mockRejectedValueOnce(new Error("Save rejected"));
    await prepare(); await click(copy.storage.emptyVolume.action);
    expect(mocks.trigger).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Save rejected");
  });
  it("retries a refused deployment without replacing the volume configuration again", async () => {
    mocks.trigger.mockRejectedValueOnce(new Error("Build already in progress"));
    await prepare(); await click(copy.storage.emptyVolume.action);
    expect(document.body.textContent).toContain(copy.storage.emptyVolume.retryHint);
    await click(copy.storage.emptyVolume.retry);
    expect(mocks.update).toHaveBeenCalledOnce();
    expect(mocks.trigger).toHaveBeenCalledTimes(2);
    expect(mocks.push).toHaveBeenCalledWith("/build/dep-empty");
  });
});
