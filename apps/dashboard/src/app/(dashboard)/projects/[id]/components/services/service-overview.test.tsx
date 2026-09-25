// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, interpolate } from "@/components/i18n-provider";
import { ModalProvider } from "@/context/ModalContext";
import { baseDictionary } from "@/i18n";
import { ServiceDetailPanel } from "./ServiceDetailPanel";

const mocks = vi.hoisted(() => ({
  volumes: vi.fn(), getEnv: vi.fn(), update: vi.fn(), policies: vi.fn(), backup: vi.fn(),
  createPolicy: vi.fn(), destinations: vi.fn(),
  refresh: vi.fn(), push: vi.fn(), toast: vi.fn(), domainProps: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ showToast: mocks.toast }) }));
vi.mock("@/context/PlatformContext", () => ({ usePlatform: () => ({ baseDomain: "opsh.test" }) }));
vi.mock("@/components/theme-provider", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("@/hooks/useLocalhostForward", () => ({ useLocalhostForward: () => ({ canForward: false }) }));
vi.mock("@/hooks/useCloudDeployPricing", () => ({ useCloudDeployPricing: () => () => false }));
vi.mock("./ServiceDomainsPanel", () => ({ ServiceDomainsPanel: (props: unknown) => { mocks.domainProps(props); return <div>Service domains</div>; } }));
vi.mock("../UseInProjectModal", () => ({ UseInProjectModal: () => null }));
vi.mock("../UsedByCard", () => ({ UsedByCard: () => null }));
vi.mock("@/components/backup/BackupRunCard", () => ({ BackupRunCard: ({ runId }: { runId: string }) => <div>{runId}</div> }));
vi.mock("@/lib/api/services", async (original) => {
  const actual = await original<typeof import("@/lib/api/services")>();
  return { ...actual, servicesApi: { ...actual.servicesApi, getEnv: mocks.getEnv, volumeSizes: mocks.volumes, update: mocks.update } };
});
vi.mock("@/lib/api", async (original) => {
  const actual = await original<typeof import("@/lib/api")>();
  return {
    ...actual,
    backupsApi: { ...actual.backupsApi, listPolicies: mocks.policies, runNow: mocks.backup, createPolicy: mocks.createPolicy },
    backupDestinationsApi: { ...actual.backupDestinationsApi, list: mocks.destinations },
  };
});

type Props = ComponentProps<typeof ServiceDetailPanel>;
const service: Props["service"] = {
  id: "svc-api", name: "api", kind: "compose", enabled: true,
  image: "example/api:current", build: null, ports: ["127.0.0.1:8080:3000", "9000"],
  volumes: ["data:/app/data:rw,cached"],
  dockerfile: null, buildArgs: null, dependsOn: [], environment: null,
  command: null, restart: "unless-stopped", exposed: true, exposedPort: "3000",
  domain: null, customDomain: "api.example.com", domainType: "custom", sortOrder: 0,
};
const copy = baseDictionary.projectDetail.services.detail;
const policy = {
  id: "policy-selected",
  serviceId: "svc-api",
  destinationId: "dest-1",
  payloadKind: "auto",
  payloadConfig: {},
  enabled: true,
};
const measured = { measurable: true, partial: false, totalBytes: 2048, volumes: [
  { raw: service.volumes![0], source: "data", target: "/app/data", kind: "named", readOnly: false, bytes: 2048 },
] };
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.getEnv.mockResolvedValue({ success: true, vars: [] });
  mocks.volumes.mockResolvedValue(measured);
  mocks.update.mockResolvedValue({ success: true });
  mocks.policies.mockResolvedValue({ data: [] });
  mocks.backup.mockResolvedValue({ data: { runId: "run-selected-service" } });
  mocks.createPolicy.mockResolvedValue({ data: policy });
  mocks.destinations.mockResolvedValue({ data: [{ id: "dest-1", name: "Backup server", kind: "local", isDefault: true }] });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function render(tab = "overview", props: Partial<Props> = {}) {
  await act(async () => root.render(<I18nProvider><ModalProvider>
    <ServiceDetailPanel service={service} projectId="project-stack" projectSlugBase="stack"
      projectType="services" deployTarget="server" initialTab={tab} onRefresh={mocks.refresh} deepLink={false} {...props} />
  </ModalProvider></I18nProvider>));
}
function button(label: string) {
  const buttons = [...document.querySelectorAll("button")];
  const found = buttons.find((element) => element.getAttribute("aria-label") === label || element.textContent?.trim() === label)
    ?? buttons.find((element) => element.textContent?.startsWith(label));
  expect(found, `button ${label}`).toBeDefined();
  return found!;
}
async function click(label: string) { await act(async () => button(label).click()); }
async function editMount(n: number, side: "host" | "service", value: string) {
  const label = `${interpolate(copy.storage.mountLabel, { n: String(n) })}: ${side === "host" ? copy.storage.hostLabel : copy.storage.serviceLabel}`;
  const element = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  expect(element).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return element;
}

describe("service overview and volumes", () => {
  it("uses the project policy for the selected service's one-click backup", async () => {
    mocks.policies.mockResolvedValue({ data: [{ ...policy, serviceId: null }] });
    await render("volumes");
    await click(copy.storage.backups);
    expect(mocks.backup).toHaveBeenCalledExactlyOnceWith("policy-selected", { serviceId: "svc-api" });
    expect(mocks.createPolicy).not.toHaveBeenCalled();
    expect(host.textContent).toContain("run-selected-service");
  });

  it("creates a service policy when customizing inherited project rules", async () => {
    mocks.policies.mockResolvedValue({ data: [{ ...policy, serviceId: null }] });
    await render("backup");
    await click(copy.createPolicy);
    const save = [...document.querySelectorAll<HTMLButtonElement>('button[type="submit"]')].at(-1)!;
    expect(save).toBeDefined();
    await act(async () => save.click());
    expect(mocks.createPolicy).toHaveBeenCalledExactlyOnceWith("project-stack", expect.objectContaining({ serviceId: "svc-api" }));
    expect(mocks.backup).not.toHaveBeenCalled();
  });

  it("keeps mounts and runtime details out of the initial overview, without measuring volumes or loading backups", async () => {
    await render();
    expect(host.textContent).toContain("api.example.com");
    expect(host.textContent).toContain(copy.networking.noDomain);
    expect(host.textContent).not.toContain("data:/app/data:rw,cached");
    expect(host.querySelector("details")?.open).toBe(false);
    expect(mocks.volumes).not.toHaveBeenCalled();
    expect(mocks.policies).not.toHaveBeenCalled();
  });

  it("opens domain setup for the clicked container port without leaving the service page", async () => {
    await render();
    await click(interpolate(copy.networking.addToPort, { port: "9000" }));
    expect(mocks.domainProps).toHaveBeenLastCalledWith(expect.objectContaining({
      projectId: "project-stack", serviceId: "svc-api", intent: { port: 9000, add: true },
    }));
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("measures volumes only when their tab opens, and completes a pending measurement once", async () => {
    let finish!: (value: unknown) => void;
    mocks.volumes.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    await render();
    await click(copy.tabs.volumes);
    expect(mocks.volumes).toHaveBeenCalledExactlyOnceWith("project-stack", "svc-api");
    expect(host.textContent).toContain(copy.storage.measuring);
    await act(async () => finish(measured));
    expect(host.textContent).not.toContain(copy.storage.measuring);
    expect(host.textContent).toContain("2.0 KB");
    expect(mocks.volumes).toHaveBeenCalledOnce();
  });

  it("offers an explicit retry after a failed measurement instead of looping", async () => {
    mocks.volumes.mockRejectedValueOnce(new Error("Host offline"));
    await render("volumes");
    expect(host.textContent).toContain(copy.storage.measureFailed);
    expect(host.textContent).not.toContain(copy.storage.measuring);
    expect(mocks.volumes).toHaveBeenCalledOnce();
    await click(copy.storage.refresh);
    expect(mocks.volumes).toHaveBeenCalledTimes(2);
    expect(host.textContent).not.toContain(copy.storage.measureFailed);
  });

  it("leaves unavailable Cloud usage unknown", async () => {
    await render("volumes", { deployTarget: "cloud" });
    expect(mocks.volumes).not.toHaveBeenCalled();
    expect(host.textContent).toContain(copy.storage.usageUnavailable);
    expect(host.textContent).not.toContain("0 B");
  });

  it("saves only this service's mounts and preserves comma-separated mount options", async () => {
    await render("volumes");
    await click(copy.storage.edit);
    await click(copy.storage.add);
    await editMount(2, "host", "./config");
    await editMount(2, "service", "/app/config");
    await act(async () =>
      host
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith("project-stack", "svc-api", {
      volumes: ["data:/app/data:rw,cached", "./config:/app/config"],
    });
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });

  it("starts this service's backup directly from Volumes and shows progress there", async () => {
    mocks.policies.mockResolvedValue({
      data: [
        { id: "policy-other", serviceId: "svc-other", payloadKind: "volume" },
        { id: "policy-selected", serviceId: "svc-api", payloadKind: "volume" },
      ],
    });
    await render("volumes");
    await click(copy.storage.backups);
    expect(mocks.policies).toHaveBeenCalledExactlyOnceWith("project-stack");
    expect(mocks.backup).toHaveBeenCalledExactlyOnceWith("policy-selected");
    expect(host.textContent).toContain("run-selected-service");
    expect(host.textContent).toContain(copy.storage.description);
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("sets up a missing backup and starts it without leaving Volumes", async () => {
    await render("volumes");
    await click(copy.storage.backups);
    expect(document.body.textContent).toContain(
      baseDictionary.widgets.backup.policyEditor.createTitle,
    );
    expect(mocks.backup).not.toHaveBeenCalled();

    mocks.policies.mockResolvedValue({ data: [policy] });
    await click(copy.storage.saveAndBackup);
    expect(mocks.createPolicy).toHaveBeenCalledExactlyOnceWith(
      "project-stack",
      expect.objectContaining({
        serviceId: "svc-api",
        destinationId: "dest-1",
        payloadKind: "volume",
        payloadConfig: {},
        cronExpression: null,
        retainCount: 7,
      }),
    );
    expect(mocks.backup).toHaveBeenCalledExactlyOnceWith("policy-selected");
    expect(host.textContent).toContain("run-selected-service");
    expect(host.textContent).toContain(copy.storage.description);
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("offers the simple first-backup action from the service Backup tab", async () => {
    await render("backup");
    await click(copy.createPolicy);
    const editor = baseDictionary.widgets.backup.policyEditor;
    expect(document.querySelector(`button[aria-label="${editor.advanced}"]`)?.getAttribute("aria-expanded")).toBe("false");
    await click(editor.quick.saveAndBackup);
    expect(mocks.createPolicy).toHaveBeenCalledExactlyOnceWith(
      "project-stack",
      expect.objectContaining({ serviceId: "svc-api", payloadKind: "volume", retainCount: 7 }),
    );
    expect(mocks.backup).toHaveBeenCalledExactlyOnceWith("policy-selected");
    expect(host.textContent).toContain("run-selected-service");
  });

  it("admits only one backup request when the shortcut is clicked twice", async () => {
    mocks.policies.mockResolvedValue({ data: [policy] });
    let finish!: (value: unknown) => void;
    mocks.backup.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await render("volumes");
    const shortcut = button(copy.storage.backups);
    await act(async () => {
      shortcut.click();
      shortcut.click();
    });
    expect(mocks.backup).toHaveBeenCalledExactlyOnceWith("policy-selected");
    expect(shortcut.disabled).toBe(true);
    await act(async () => finish({ data: { runId: "run-selected-service" } }));
    expect(host.textContent).toContain("run-selected-service");
    expect(shortcut.disabled).toBe(false);
  });

  it("keeps a failed policy lookup in Volumes and lets the user retry it", async () => {
    mocks.policies.mockRejectedValueOnce(new Error("Backup settings are unavailable"));
    await render("volumes");
    expect(host.textContent).toContain("Backup settings are unavailable");
    expect(button(copy.storage.backups).disabled).toBe(true);
    expect(mocks.createPolicy).not.toHaveBeenCalled();
    mocks.policies.mockResolvedValue({ data: [policy] });
    await click(copy.storage.retry);
    await click(copy.storage.backups);
    expect(mocks.backup).toHaveBeenCalledExactlyOnceWith("policy-selected");
    expect(host.textContent).not.toContain("Backup settings are unavailable");
  });

  it("does not show a previous service's backup response after switching services", async () => {
    mocks.policies.mockResolvedValue({ data: [policy] });
    let finish!: (value: unknown) => void;
    mocks.backup.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await render("volumes");
    await click(copy.storage.backups);
    await render("volumes", { service: { ...service, id: "svc-other" } });
    await act(async () => finish({ data: { runId: "old-service-backup" } }));
    expect(host.textContent).not.toContain("old-service-backup");
  });

  it("does not start a backup from a setup form after switching services", async () => {
    let finish!: (value: unknown) => void;
    mocks.createPolicy.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await render("volumes");
    await click(copy.storage.backups);
    await click(copy.storage.saveAndBackup);
    expect(mocks.createPolicy).toHaveBeenCalledOnce();
    await render("volumes", { service: { ...service, id: "svc-other" } });
    await act(async () => finish({ data: policy }));
    expect(mocks.backup).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("run-selected-service");
  });

  it("preserves anonymous storage and non-access options when editing a path or read-only access", async () => {
    await render("volumes", {
      service: { ...service, volumes: ["/cache:ro", "data:/data:ro,z,cached"] },
    });
    await click(copy.storage.edit);
    await editMount(1, "service", "/cache/new");
    const readOnlyLabel = `${interpolate(copy.storage.mountLabel, { n: "2" })}: ${copy.storage.readOnly}`;
    await act(async () =>
      host.querySelector<HTMLInputElement>(`input[aria-label="${readOnlyLabel}"]`)!.click(),
    );
    await act(async () =>
      host
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith("project-stack", "svc-api", {
      volumes: ["/cache/new:ro", "data:/data:z,cached"],
    });
  });

  it.each(["relative/path", ""])(
    "rejects the service path %j without replacing saved mounts",
    async (target) => {
      await render("volumes", { service: { ...service, volumes: ["/data"] } });
      await click(copy.storage.edit);
      const input = await editMount(1, "service", target);
      await act(async () =>
        host
          .querySelector("form")!
          .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
      );
      expect(host.textContent).toContain(copy.storage.invalidMount);
      expect(mocks.update).not.toHaveBeenCalled();
      expect(input.value).toBe(target);
    },
  );

  it("does not overwrite mounts when saving the separate Settings tab", async () => {
    await render("settings");
    expect(host.querySelector(`input[aria-label="${baseDictionary.projectDetail.services.settingsForm.volumes}"]`)).toBeNull();
    await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(mocks.update).toHaveBeenCalledOnce();
    expect(mocks.update.mock.calls[0][2]).not.toHaveProperty("volumes");
  });

  it("ignores a previous service's measurement after switching services", async () => {
    let finish!: (value: unknown) => void;
    mocks.volumes.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    await render("volumes");
    mocks.volumes.mockResolvedValue({ measurable: true, partial: false, totalBytes: 100, volumes: [
      { raw: "other:/data", source: "other", target: "/data", kind: "named", readOnly: false, bytes: 100 },
    ] });
    await render("volumes", { service: { ...service, id: "svc-other", volumes: ["other:/data"] } });
    await act(async () => finish(measured));
    expect(host.textContent).toContain("other");
    expect(host.textContent).toContain("/data");
    expect(host.textContent).toContain("100 B");
    expect(host.textContent).not.toContain("2 KB");
  });
});
