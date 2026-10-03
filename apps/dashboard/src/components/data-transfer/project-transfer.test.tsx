// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DataTransferFile, ImportPreview, TransferManifest } from "@/lib/api/data-transfer";
import { ExportPanel } from "./ExportPanel";
import { ImportModal } from "./ImportModal";
import { ALL_HISTORY } from "./TransferOptions";

const h = vi.hoisted(() => ({
  preview: vi.fn(), export: vi.fn(), previewFile: vi.fn(), importFile: vi.fn(),
  toast: vi.fn(), objectUrl: vi.fn(), revokeUrl: vi.fn(),
}));
vi.mock("@/lib/api/data-transfer", () => ({ dataTransferApi: {
  preview: h.preview, export: h.export, previewFile: h.previewFile, importFile: h.importFile,
} }));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ showToast: h.toast }) }));
vi.mock("@/components/ui/Modal", () => ({ Modal: ({ isOpen, children }: { isOpen: boolean; children: ReactNode }) =>
  isOpen ? <div>{children}</div> : null,
}));

const project = {
  id: "web", groupId: "group-web", organizationId: "org-source", name: "Web", slug: "web",
  environmentName: "Production", serverId: "server-a", workspaceId: null, cloudWorkspaceId: null, localPath: null,
};
const manifest: TransferManifest = {
  projects: [project],
  servers: [{ id: "server-a", name: "App host", host: "203.0.113.10", port: 2222,
    isLocal: false, included: true, hasCredentials: true }],
  cloudAccounts: [{ organizationId: "org-source", email: "owner@example.test" }],
  warnings: [],
};
const fileReply: DataTransferFile = {
  kind: "openship-project-export", envelopeVersion: 4, manifest,
  secrets: { encoding: "plaintext", version: 1, entries: [{ value: "exported-env-value" }] },
};
const history = { analytics: 0, activity: 0, backups: 0, incidents: 0, migrations: 0 };
const importPreview: ImportPreview = {
  scope: "projects", projects: [{ ...project, action: "create" }], servers: [],
  availableServers: [], history, rows: 12, hasSecrets: true, requiresPassphrase: false,
  warnings: [], blockers: [],
};

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL = h.objectUrl;
    static revokeObjectURL = h.revokeUrl;
  });
  h.objectUrl.mockReturnValue("blob:project-export");
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  h.preview.mockResolvedValue({
    core: 12, total: 12, history,
    manifest: { ...manifest, servers: [{ ...manifest.servers[0], name: "Earlier host", host: "203.0.113.9" }] },
  });
  h.export.mockResolvedValue(fileReply);
  h.previewFile.mockResolvedValue(importPreview);
  h.importFile.mockResolvedValue({
    mode: "merge", rowsRestored: 12, secretsRehydrated: 4, secretsSkipped: false,
    localPathProjects: [], projectsCreated: 1, projectsUpdated: 0, projectsSkipped: 0,
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function button(text: string): HTMLButtonElement {
  const result = [...host.querySelectorAll("button")].find((node) => node.textContent?.trim() === text);
  expect(result, `button ${text}`).toBeDefined();
  return result!;
}
async function renderExport() {
  await act(async () => root.render(<ExportPanel projectId="web" projectName="Web" />));
  await act(async () => vi.advanceTimersByTimeAsync(300));
}
async function chooseImportFile() {
  await act(async () => root.render(<ImportModal open onClose={() => undefined} />));
  const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  const file = new File(["{}"], "openship-web.json", { type: "application/json" });
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  return file;
}

describe("project file transfer", () => {
  it("downloads everything in one action and shows the exported server and Cloud account", async () => {
    let complete!: (file: DataTransferFile) => void;
    h.export.mockImplementation(() => new Promise<DataTransferFile>((resolve) => { complete = resolve; }));
    await renderExport();
    expect(host.querySelector('input[type="password"]')).toBeNull();
    expect(host.querySelector('input[type="checkbox"]')).toBeNull();
    await act(async () => {
      button("Download export").click();
      button("Download export").click();
    });
    expect(h.export).toHaveBeenCalledExactlyOnceWith(undefined, {
      scope: "projects", projectIds: ["web"], history: ALL_HISTORY,
      includeEnvironments: true, includeLinkedProjects: true, includeServers: true,
      includeSecrets: true, includeDomains: true, includeBackups: true, includeIntegrations: true,
    });
    expect(button("Exporting…").disabled).toBe(true);
    await act(async () => complete(fileReply));
    const blob = h.objectUrl.mock.calls[0]![0] as Blob;
    expect(JSON.parse(await blob.text())).toEqual(fileReply);
    expect(host.textContent).toContain("Export downloaded");
    expect(host.textContent).toContain("Required on the destination");
    expect(host.textContent).toContain("App host");
    expect(host.textContent).toContain("203.0.113.10:2222");
    expect(host.textContent).toContain("owner@example.test");
    expect(host.textContent).not.toContain("Earlier host");
  });

  it("allows retrying a failed download without reporting completion", async () => {
    h.export.mockRejectedValueOnce(new Error("Export unavailable"));
    await renderExport();
    await act(async () => button("Download export").click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Export unavailable");
    expect(host.textContent).not.toContain("Export downloaded");
    expect(button("Download export").disabled).toBe(false);
    await act(async () => button("Download export").click());
    expect(host.textContent).toContain("Export downloaded");
    expect(h.export).toHaveBeenCalledTimes(2);
  });

  it("downloads an entire instance with credentials and all history without a password", async () => {
    h.export.mockResolvedValue({ ...fileReply, kind: "openship-instance-export" });
    await act(async () => root.render(<ExportPanel />));
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(host.querySelector('input[type="password"]')).toBeNull();
    await act(async () => button("Download export").click());
    expect(h.export).toHaveBeenCalledExactlyOnceWith(undefined, expect.objectContaining({
      scope: "instance", history: ALL_HISTORY, includeSecrets: true,
    }));
    const blob = h.objectUrl.mock.calls[0]![0] as Blob;
    expect(await blob.text()).toContain("exported-env-value");
  });

  it("preserves instance scope and requires confirmation before replacement", async () => {
    h.previewFile.mockResolvedValue({ ...importPreview, scope: "instance" });
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    vi.stubGlobal("confirm", confirm);
    const file = await chooseImportFile();
    expect(host.querySelector<HTMLSelectElement>('[aria-label="Import scope"]')!.value).toBe("instance");
    expect(host.querySelector<HTMLSelectElement>('[aria-label="Instance import mode"]')!.value).toBe("wipe");
    expect(host.querySelector('input[type="password"]')).toBeNull();
    await act(async () => button("Replace instance").click());
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(h.importFile).not.toHaveBeenCalled();
    await act(async () => {
      button("Replace instance").click();
      button("Replace instance").click();
    });
    expect(h.importFile).toHaveBeenCalledExactlyOnceWith(file, undefined, "wipe", expect.any(Function),
      expect.objectContaining({ scope: "instance", includeSecrets: true }));
  });

  it("requires a fresh review when the instance import mode changes", async () => {
    h.previewFile.mockResolvedValue({ ...importPreview, scope: "instance" });
    await chooseImportFile();
    await act(async () => {
      const select = host.querySelector<HTMLSelectElement>('[aria-label="Instance import mode"]')!;
      select.value = "merge";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(button("Import selection").disabled).toBe(true);
    await act(async () => button("Review selection").click());
    expect(button("Import selection").disabled).toBe(false);
  });

  it("reviews an explicit project overwrite and shows destination-only record removal", async () => {
    await chooseImportFile();
    await act(async () => {
      const select = host.querySelector<HTMLSelectElement>('[aria-label="Project conflict policy"]')!;
      select.value = "overwrite";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(button("Import selection").disabled).toBe(true);
    h.previewFile.mockResolvedValue({ ...importPreview, rowsRemoved: 3,
      projects: [{ ...project, action: "overwrite", existingProjectId: "web" }],
    });
    await act(async () => button("Review selection").click());
    expect(host.textContent).toContain("3 destination-only records will be removed");
    await act(async () => button("Import selection").click());
    expect(h.importFile).toHaveBeenCalledWith(expect.any(File), undefined, "merge", expect.any(Function),
      expect.objectContaining({ conflictPolicy: "overwrite" }));
  });

  it("imports a plain project file with all credentials and no password field", async () => {
    const file = await chooseImportFile();
    expect(host.querySelector('input[type="password"]')).toBeNull();
    expect(button("Import selection").disabled).toBe(false);
    await act(async () => button("Import selection").click());
    expect(h.importFile).toHaveBeenCalledExactlyOnceWith(
      file, undefined, "merge", expect.any(Function), expect.objectContaining({
        scope: "projects", projectIds: ["web"], includeSecrets: true,
      }),
    );
    expect(host.textContent).toContain("Import complete");
    expect(host.textContent).toContain("4 credential records restored");
  });

  it("still unlocks older password-protected files before importing", async () => {
    h.previewFile.mockResolvedValue({ ...importPreview, requiresPassphrase: undefined });
    const file = await chooseImportFile();
    const password = host.querySelector<HTMLInputElement>('input[type="password"]')!;
    expect(password).not.toBeNull();
    expect(button("Import selection").disabled).toBe(true);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(password, "legacy-password");
      password.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Import selection").click());
    expect(h.importFile).toHaveBeenCalledWith(file, "legacy-password", "merge", expect.any(Function), expect.any(Object));
  });
});
