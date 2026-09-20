// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardProviders } from "@/app/(dashboard)/providers";
import { CreateDestinationModal } from "@/app/(dashboard)/backups/_components/CreateDestinationModal";
import { I18nProvider } from "@/components/i18n-provider";
import { ModalProvider } from "@/context/ModalContext";
import { baseDictionary } from "@/i18n";

const api = vi.hoisted(() => ({
  list: vi.fn(),
  createServer: vi.fn(),
  createDestination: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("@/lib/api/system", () => ({
  systemApi: {
    listServers: api.list,
    createServerEntry: api.createServer,
    hasNativeFilePicker: () => false,
  },
}));
vi.mock("@/lib/api", () => ({
  systemApi: {
    listServers: api.list,
    createServerEntry: api.createServer,
    hasNativeFilePicker: () => false,
  },
  backupDestinationsApi: { create: api.createDestination },
  getApiErrorMessage: (error: Error) => error.message,
}));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ showToast: api.toast }) }));
// Import the real picker without unrelated cards whose .js files contain JSX.
vi.mock("@/components/shared", async () => ({
  ServerSelector: (await import("@/components/shared/ServerSelector")).default,
}));
// Keep the actual dashboard provider composition, platform context, both modal
// providers, portals, destination form, server picker and server form. These
// unrelated providers fetch account/provider state and are not needed here.
vi.mock("@/context/AuthContext", () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/context/GitHubContext", () => ({
  GitHubProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/context/CloudContext", () => ({
  CloudProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/context/MailScopeContext", () => ({
  MailScopeProvider: ({ children }: { children: ReactNode }) => children,
}));

let root: Root;
let host: HTMLDivElement;
const savedServer = {
  id: "server-new",
  name: "Backup server",
  sshHost: "192.0.2.10",
  sshPort: 22,
  sshUser: "root",
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.list.mockResolvedValue([]);
  api.createServer.mockResolvedValue(savedServer);
  api.createDestination.mockResolvedValue({ id: "destination-new" });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const backup = baseDictionary.misc.backups;
const form = baseDictionary.servers.form;
function button(label: string, exact = true) {
  const found = [...document.querySelectorAll("button")].find((node) =>
    exact ? node.textContent?.trim() === label : node.textContent?.includes(label),
  );
  expect(found, `button ${label}`).toBeDefined();
  return found!;
}
async function click(label: string, exact = true) {
  await act(async () => button(label, exact).click());
}
async function edit(input: HTMLInputElement | null, value: string) {
  expect(input).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function open(productView: "platform" | "mail" = "platform") {
  await act(async () =>
    root.render(
      <I18nProvider>
        <ModalProvider>
          <DashboardProviders
            selfHosted
            deployMode="docker"
            authMode="local"
            productView={productView}
            cloudAuthUrl="https://cloud.example.test"
            cloudApiUrl="https://api.example.test"
          >
            <CreateDestinationModal isOpen onClose={() => {}} onSaved={async () => {}} />
          </DashboardProviders>
        </ModalProvider>
      </I18nProvider>,
    ),
  );
  await click(backup.kindServer, false);
  const name =
    [...document.querySelectorAll("label")]
      .find((node) => node.textContent?.trim() === backup.fieldName)
      ?.querySelector("input") ?? null;
  await edit(name, "Hourly backup");
  await edit(document.querySelector('input[placeholder="/backups/openship"]'), "/backups/hourly");
  await click(baseDictionary.widgets.shared.serverSelector.addServer, false);
}
async function fillServer() {
  await edit(document.querySelector('input[placeholder="123.45.67.89"]'), savedServer.sshHost);
  await edit(document.querySelector('input[type="password"]'), "test-only-password");
}

describe("add server from backup destination (#836)", () => {
  it.each(["platform", "mail"] as const)(
    "saves and selects the new server without losing the %s destination form",
    async (view) => {
      await open(view);
      await fillServer();
      await click(form.saveServer);
      expect(api.createServer).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ sshHost: savedServer.sshHost }),
      );
      expect(document.querySelector('input[placeholder="123.45.67.89"]')).toBeNull();
      expect(document.body.textContent).toContain(savedServer.name);
      await click(backup.saveDestination);
      expect(api.createDestination).toHaveBeenCalledExactlyOnceWith({
        name: "Hourly backup",
        kind: "openship_server",
        serverId: savedServer.id,
        pathPrefix: "/backups/hourly",
      });
    },
  );

  it("keeps a failed save editable and returns the selected server only after a successful retry", async () => {
    await open();
    await fillServer();
    api.createServer.mockRejectedValueOnce(new Error("SSH credentials were rejected"));
    await click(form.saveServer);
    expect(
      document.querySelector<HTMLInputElement>('input[placeholder="123.45.67.89"]')?.value,
    ).toBe(savedServer.sshHost);
    expect(api.toast).toHaveBeenCalledWith(
      "SSH credentials were rejected",
      "error",
      expect.any(String),
    );
    expect(api.createDestination).not.toHaveBeenCalled();
    await click(form.saveServer);
    await click(backup.saveDestination);
    expect(api.createDestination).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: savedServer.id }),
    );
  });
});
