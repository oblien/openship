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
  deployMode: "local", saveTunnel: vi.fn(), startTunnel: vi.fn(),
  runtimeUpdate: vi.fn(), runtimeCheck: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ showToast: mocks.toast }) }));
vi.mock("@/context/PlatformContext", () => ({ usePlatform: () => ({ baseDomain: "opsh.test", deployMode: mocks.deployMode }) }));
vi.mock("@/components/theme-provider", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("@/hooks/useCloudDeployPricing", () => ({ useCloudDeployPricing: () => () => false }));
vi.mock("@/lib/api/updates", () => ({ updatesApi: { updateRuntime: mocks.runtimeUpdate, checkRuntime: mocks.runtimeCheck } }));
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
    systemApi: { ...actual.systemApi, saveTunnel: mocks.saveTunnel, startTunnel: mocks.startTunnel },
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
  mocks.deployMode = "local";
  mocks.saveTunnel.mockResolvedValue({ id: "private-tunnel" });
  mocks.startTunnel.mockResolvedValue({ url: "http://localhost:49100" });
  vi.spyOn(window, "open").mockReturnValue(null);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.getEnv.mockResolvedValue({ success: true, vars: [] });
  mocks.volumes.mockResolvedValue(measured);
  mocks.update.mockResolvedValue({ success: true });
  mocks.runtimeUpdate.mockResolvedValue({ data: { deployment_id: "dep-image-refresh", project_id: "project-stack" } });
  mocks.runtimeCheck.mockResolvedValue({ data: { checkedAt: new Date().toISOString(), images: [], verification: {} } });
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

it("offers image apps the same scoped redeploy and image-check controls", async () => {
  await render("overview", { projectType: "app", activeDeploymentId: "active" });
  expect([...host.querySelectorAll("button")].some((element) => element.textContent === copy.redeploy)).toBe(false);
  await act(async () => button(baseDictionary.projects.card.more).click());
  await act(async () => button(baseDictionary.projectSettings.runtimeUpdates.check).click());
  expect(mocks.runtimeCheck).toHaveBeenCalledExactlyOnceWith("project-stack", { serviceIds: [service.id] });
  expect(mocks.runtimeUpdate).not.toHaveBeenCalled();
  await act(async () => button(baseDictionary.projects.card.more).click());
  await act(async () => button(copy.redeploy).click());
  expect(mocks.runtimeUpdate).toHaveBeenCalledExactlyOnceWith("project-stack", { serviceIds: [service.id] });
  expect(mocks.push).toHaveBeenCalledWith("/build/dep-image-refresh");
});

it("refreshes source service base images from the shared More menu", async () => {
  await render("overview", { activeDeploymentId: "active", service: { ...service, image: null, build: "." } });
  await act(async () => button(baseDictionary.projects.card.more).click());
  await act(async () => button(baseDictionary.projectSettings.runtimeUpdates.refresh).click());
  expect(mocks.runtimeUpdate).toHaveBeenCalledExactlyOnceWith("project-stack", { serviceIds: [service.id] });
  expect(mocks.push).toHaveBeenCalledWith("/build/dep-image-refresh");
});
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
  it("opens a private service's TCP port through its live container IP without publishing it", async () => {
    mocks.deployMode = "desktop";
    let started!: (value: { url: string }) => void;
    mocks.startTunnel.mockImplementation(
      () =>
        new Promise((resolve) => {
          started = resolve;
        }),
    );
    const privateService = {
      ...service,
      ports: ["5432/tcp"],
      exposed: false,
      exposedPort: null,
      domain: null,
      customDomain: null,
      publicEndpoints: null,
    };
    await render("overview", {
      service: privateService,
      serverId: "server-db",
      container: {
        serviceId: service.id,
        serviceName: service.name,
        containerId: "private-db",
        status: "running",
        ip: "172.22.0.3",
        hostPort: null,
        imageRef: service.image,
      },
    });
    const open = button(baseDictionary.projects.connections.openLocalhost);
    expect(open.disabled).toBe(false);
    await act(async () => {
      open.click();
      open.click();
    });
    expect(mocks.saveTunnel).toHaveBeenCalledExactlyOnceWith("server-db", {
      remoteHost: "172.22.0.3",
      remotePort: 5432,
    });
    expect(mocks.startTunnel).toHaveBeenCalledExactlyOnceWith(
      "server-db",
      "private-tunnel",
    );
    expect(open.disabled).toBe(true);
    expect(window.open).not.toHaveBeenCalled();
    await act(async () => started({ url: "http://localhost:49100" }));
    expect(window.open).toHaveBeenCalledExactlyOnceWith(
      "http://localhost:49100",
      "_blank",
      "noopener",
    );
    expect(open.disabled).toBe(false);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("uses the observed host port when a running service has no container IP", async () => {
    mocks.deployMode = "desktop";
    await render("overview", {
      serverId: "server-web",
      container: {
        serviceId: service.id,
        serviceName: service.name,
        containerId: "web",
        status: "running",
        ip: null,
        hostPort: 49123,
        imageRef: service.image,
      },
    });
    await click(baseDictionary.projects.connections.openLocalhost);
    expect(mocks.saveTunnel).toHaveBeenCalledExactlyOnceWith("server-web", {
      remoteHost: "127.0.0.1",
      remotePort: 49123,
    });
  });

  it.each([
    { status: "unknown", ip: "172.22.0.3", hostPort: 49123 },
    { status: "stopped", ip: "172.22.0.3", hostPort: 49123 },
    { status: "running", ip: null, hostPort: null },
  ])(
    "does not guess a localhost target from saved ports when runtime is $status and IP is $ip",
    async ({ status, ip, hostPort }) => {
      mocks.deployMode = "desktop";
      await render("overview", {
        serverId: "server-db",
        service: {
          ...service,
          ports: ["5432"],
          exposed: false,
          exposedPort: null,
          domain: null,
          customDomain: null,
          publicEndpoints: null,
        },
        container: {
          serviceId: service.id,
          serviceName: service.name,
          containerId: "private-db",
          status,
          ip,
          hostPort,
          imageRef: service.image,
        },
      });
      const open = button(baseDictionary.projects.connections.openLocalhost);
      expect(open.disabled).toBe(true);
      await act(async () => open.click());
      expect(mocks.saveTunnel).not.toHaveBeenCalled();
    },
  );

  it.each([{ ports: null }, { ports: ["53/udp"] }])(
    "asks for a TCP port instead of guessing when saved ports are $ports",
    async ({ ports }) => {
      mocks.deployMode = "desktop";
      await render("overview", {
        serverId: "server-private",
        service: {
          ...service,
          ports,
          exposed: false,
          exposedPort: null,
          domain: null,
          customDomain: null,
          publicEndpoints: null,
        },
        container: {
          serviceId: service.id,
          serviceName: service.name,
          containerId: "private-service",
          status: "running",
          ip: "172.22.0.3",
          hostPort: null,
          imageRef: service.image,
        },
      });
      await click(baseDictionary.projects.connections.openLocalhost);
      expect(mocks.saveTunnel).not.toHaveBeenCalled();
      const dialog = document.querySelector('[role="dialog"]')!;
      expect(dialog).not.toBeNull();
      const input = dialog.querySelector<HTMLInputElement>(
        'input[type="number"]',
      )!;
      const submit = dialog.querySelector<HTMLButtonElement>(
        'button[type="submit"]',
      )!;
      expect(submit.disabled).toBe(true);
      for (const value of ["65536", "5432"]) {
        await act(async () => {
          Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            "value",
          )!.set!.call(input, value);
          input.dispatchEvent(new Event("input", { bubbles: true }));
        });
        expect(submit.disabled).toBe(value === "65536");
      }
      mocks.startTunnel.mockRejectedValueOnce(new Error("SSH connection lost"));
      await act(async () => submit.click());
      expect(window.open).not.toHaveBeenCalled();
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      expect(submit.disabled).toBe(false);
      expect(input.value).toBe("5432");
      await act(async () => submit.click());
      expect(mocks.saveTunnel).toHaveBeenNthCalledWith(2, "server-private", {
        remoteHost: "172.22.0.3",
        remotePort: 5432,
      });
      expect(mocks.saveTunnel).toHaveBeenCalledTimes(2);
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(window.open).toHaveBeenCalledExactlyOnceWith(
        "http://localhost:49100",
        "_blank",
        "noopener",
      );
      expect(mocks.update).not.toHaveBeenCalled();
    },
  );

  it.each(["local", "cloud"])(
    "does not start a browser-local listener in %s mode",
    async (mode) => {
      mocks.deployMode = mode;
      await render("overview", { serverId: "server-db" });
      expect(host.textContent).not.toContain(
        baseDictionary.projects.connections.openLocalhost,
      );
      expect(mocks.saveTunnel).not.toHaveBeenCalled();
    },
  );

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
