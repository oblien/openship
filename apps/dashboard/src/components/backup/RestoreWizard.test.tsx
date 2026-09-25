// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
import { baseDictionary } from "@/i18n";
import type { BackupRun, BackupRestore } from "@/lib/api";
import type { UseRestoreRunStreamResult } from "@/hooks/useRestoreRunStream";
import { RestoreWizard } from "./RestoreWizard";

const api = vi.hoisted(() => ({
  protect: vi.fn(),
  prepare: vi.fn(),
  apply: vi.fn(),
  cancel: vi.fn(),
  stream: vi.fn(),
  close: vi.fn(),
  reconnect: vi.fn(),
}));
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    backupsApi: {
      ...actual.backupsApi,
      protectRun: api.protect,
      prepareRestore: api.prepare,
      applyRestore: api.apply,
      cancelRestore: api.cancel,
    },
  };
});
vi.mock("@/hooks/useRestoreRunStream", () => ({ useRestoreRunStream: api.stream }));

const m = baseDictionary.misc.restoreWizard;
const w = baseDictionary.widgets.backup.runCard;
const source = {
  id: "saved-run",
  serviceId: "service-data",
  startedAt: "2026-09-24T00:00:00Z",
  bytesTransferred: 512,
  artifacts: [{ sizeBytes: 100 * 1024 * 1024 }],
} as BackupRun;
let stream: UseRestoreRunStreamResult;
let root: Root;
let host: HTMLDivElement;
const render = () =>
  act(async () =>
    root.render(
      <I18nProvider>
        <RestoreWizard sourceRun={source} serviceName="Database" onClose={api.close} />
      </I18nProvider>,
    ),
  );
function button(text: string) {
  const found = [...host.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === text,
  );
  expect(found, text).toBeDefined();
  return found!;
}
const click = (text: string) => act(async () => button(text).click());
const closeButton = () => host.querySelector<HTMLButtonElement>(`button[aria-label="${m.close}"]`)!;
async function status(status: BackupRestore["status"], extra: Partial<BackupRestore> = {}) {
  stream.restore = {
    id: "restore-one",
    status,
    bytesRestored: 100 * 1024 * 1024,
    ...extra,
  } as BackupRestore;
  await render();
}
async function typeName(value: string) {
  const input = host.querySelector<HTMLInputElement>('input:not([type="checkbox"])')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.protect.mockResolvedValue({ data: { ok: true } });
  api.prepare.mockResolvedValue({
    data: { restoreId: "restore-one", confirmationToken: "one-time-confirmation" },
  });
  api.apply.mockResolvedValue({ data: { ok: true } });
  api.cancel.mockResolvedValue({ data: { status: "cancelled" } });
  stream = {
    restore: null,
    warnings: [],
    connected: false,
    reconnecting: false,
    error: null,
    reconnect: api.reconnect,
  };
  api.stream.mockImplementation(() => stream);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("restore workflow", () => {
  it("shows the reconstructed backup size and describes protection of the selected restore point", async () => {
    await render();
    expect(host.textContent).toContain("100.0 MB");
    expect(host.textContent).toContain(m.protectHint);
    expect(host.textContent).not.toContain("right before this restore");
  });

  it("surfaces protection failure and does not silently continue", async () => {
    api.protect.mockRejectedValueOnce(new Error("This backup was already purged"));
    await render();
    await click(m.continuePrepare);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      "This backup was already purged",
    );
    expect(api.prepare).not.toHaveBeenCalled();
    expect(api.apply).not.toHaveBeenCalled();
    await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await click(m.continuePrepare);
    expect(api.protect).toHaveBeenCalledTimes(1);
    expect(api.prepare).toHaveBeenCalledWith(source.id);
  });

  it("requires successful preparation and exact name confirmation before applying with its token", async () => {
    await render();
    await click(m.continuePrepare);
    expect(api.protect).toHaveBeenCalledWith(source.id, { protected: true });
    expect(api.apply).not.toHaveBeenCalled();
    await status("prepared");
    expect(button(m.applyRestore).disabled).toBe(true);
    await typeName("database");
    expect(button(m.applyRestore).disabled).toBe(true);
    await typeName("Database");
    await click(m.applyRestore);
    expect(api.apply).toHaveBeenCalledWith("restore-one", "one-time-confirmation");
    expect(closeButton().disabled).toBe(true);
  });

  it("cancels a prepared restore when closed and keeps cancellation failures visible", async () => {
    await render();
    await click(m.continuePrepare);
    await status("prepared");
    api.cancel.mockRejectedValueOnce(new Error("Server unavailable"));
    await act(async () => closeButton().click());
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Server unavailable");
    expect(api.close).not.toHaveBeenCalled();
    await act(async () => closeButton().click());
    expect(api.cancel).toHaveBeenCalledWith("restore-one");
    expect(api.close).toHaveBeenCalledOnce();
  });

  it("keeps destructive cancellation visible until the server reports the final data state", async () => {
    await render();
    await click(m.continuePrepare);
    await status("applying", { meta: { destructive: true } });
    await click(m.abortRestore);
    expect(host.textContent).toContain(m.abortBodyDestructive);
    expect(api.cancel).not.toHaveBeenCalled();
    api.cancel.mockResolvedValueOnce({ data: { status: "applying" } });
    await click(m.abortConfirm);
    expect(host.textContent).toContain(m.cancelPending);
    expect(api.close).not.toHaveBeenCalled();
    await status("cancelled", {
      errorMessage: "Cancelled after writing began",
      meta: { partialWrite: true, serviceLeftStopped: true },
    });
    expect(host.textContent).toContain(m.partialDataNotice);
    expect(closeButton().disabled).toBe(false);
  });

  it("shows verification advisories and reconnects progress without replaying restore actions", async () => {
    await render();
    await click(m.continuePrepare);
    stream.warnings = ["This legacy artifact has no stored checksum"];
    stream.reconnecting = true;
    await render();
    expect(host.textContent).toContain(stream.warnings[0]);
    expect(host.textContent).toContain(w.reconnecting);
    await click(w.reconnect);
    expect(api.reconnect).toHaveBeenCalledOnce();
    expect(api.prepare).toHaveBeenCalledOnce();
    expect(api.apply).not.toHaveBeenCalled();
  });
});
