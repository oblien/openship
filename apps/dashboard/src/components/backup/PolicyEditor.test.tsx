// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
import { ModalProvider } from "@/context/ModalContext";
import { baseDictionary } from "@/i18n";
import type { BackupDestinationSummary, BackupPolicy, BackupRun } from "@/lib/api";
import { BackupSettings } from "@/app/(dashboard)/projects/[id]/components/BackupSettings";
import { PolicyEditor } from "./PolicyEditor";

const api = vi.hoisted(() => ({
  destinations: vi.fn(),
  createDestination: vi.fn(),
  updateDestination: vi.fn(),
  preflight: vi.fn(),
  createPolicy: vi.fn(),
  updatePolicy: vi.fn(),
  runNow: vi.fn(),
  protectRun: vi.fn(),
  stream: vi.fn(),
  policies: vi.fn(),
  runs: vi.fn(),
  saved: vi.fn(),
  savedAndRun: vi.fn(),
  close: vi.fn(),
}));
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    backupDestinationsApi: {
      ...actual.backupDestinationsApi,
      list: api.destinations,
      create: api.createDestination,
      update: api.updateDestination,
      preflight: api.preflight,
    },
    backupsApi: {
      ...actual.backupsApi,
      createPolicy: api.createPolicy,
      updatePolicy: api.updatePolicy,
      listPolicies: api.policies,
      listRuns: api.runs,
      runNow: api.runNow,
      protectRun: api.protectRun,
    },
  };
});
vi.mock("@/hooks/useBackupRunStream", () => ({ useBackupRunStream: api.stream }));
vi.mock("@/context/ProjectSettingsContext", () => ({
  useProjectSettings: () => ({
    projectData: { id: "project-1" },
    servicesData: { services: [{ id: "service-1", name: "Database", image: "postgres:17" }] },
  }),
}));
// Keep the real destination form and server picker without unrelated JSX .js cards.
vi.mock("@/components/shared", async () => ({
  ServerSelector: (await import("@/components/shared/ServerSelector")).default,
}));

const w = baseDictionary.widgets.backup.policyEditor;
const m = baseDictionary.misc.backups;
const addDestination = "Add new destination";
const destination: BackupDestinationSummary = {
  id: "destination-new",
  name: "Daily archive",
  kind: "sftp",
  endpoint: null,
  region: null,
  bucket: null,
  pathPrefix: "/backups/daily",
  sshHost: "backups.example.test",
  sshPort: 22,
  sshUser: "backup",
  serverId: null,
  hasAccessKeyId: false,
  hasSecretAccessKey: false,
  hasSftpPassword: true,
  hasSftpPrivateKey: false,
  hasSftpKeyPassphrase: false,
  lastVerifiedAt: null,
  lastVerifyError: null,
  isDefault: false,
  createdAt: "2026-09-23T00:00:00Z",
  updatedAt: "2026-09-23T00:00:00Z",
  stats: null,
};
const previousDestination = { ...destination, id: "destination-old", name: "Existing archive" };

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.destinations.mockResolvedValue({ data: [previousDestination] });
  api.createDestination.mockResolvedValue({ data: destination });
  api.updateDestination.mockResolvedValue({ data: destination });
  api.preflight.mockResolvedValue({ data: { ok: true } });
  api.createPolicy.mockResolvedValue({ data: { id: "policy-1" } });
  api.updatePolicy.mockResolvedValue({ data: { id: "policy-1" } });
  api.runNow.mockResolvedValue({ data: { runId: "run-1" } });
  api.protectRun.mockResolvedValue({ data: { ok: true } });
  api.stream.mockReturnValue({ run: null, connected: false, error: null });
  api.policies.mockResolvedValue({ data: [] });
  api.runs.mockResolvedValue({ data: [] });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function button(text: string, exact = true): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((node) =>
    exact ? node.textContent?.trim() === text : node.textContent?.includes(text),
  );
  expect(found, `button ${text}`).toBeDefined();
  return found!;
}
const click = (text: string, exact = true) => act(async () => button(text, exact).click());
function field(label: string): HTMLInputElement | HTMLTextAreaElement {
  const node = [...document.querySelectorAll("label")].find(
    (node) =>
      node.textContent?.trim() === label || node.firstElementChild?.textContent?.trim() === label,
  );
  const input =
    node?.querySelector<HTMLInputElement | HTMLTextAreaElement>("input, textarea") ??
    node?.parentElement?.querySelector<HTMLInputElement | HTMLTextAreaElement>("input, textarea");
  expect(input, `field ${label}`).toBeTruthy();
  return input!;
}
async function edit(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype =
      input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function open(settings = false, props: Partial<ComponentProps<typeof PolicyEditor>> = {}) {
  await act(async () =>
    root.render(
      <I18nProvider>
        <ModalProvider>
          {settings ? (
            <BackupSettings />
          ) : (
            <PolicyEditor
              projectId="project-1"
              serviceId="service-1"
              onClose={api.close}
              onSaved={api.saved}
              {...props}
            />
          )}
        </ModalProvider>
      </I18nProvider>,
    ),
  );
}
async function openDestinationPicker() {
  const label = [...document.querySelectorAll("label")].find(
    (node) => node.textContent?.trim() === w.destination,
  );
  const trigger = label?.parentElement?.querySelector("button");
  expect(trigger).not.toBeNull();
  await act(async () => trigger!.click());
}
async function addSftpDestination() {
  await openDestinationPicker();
  await click(addDestination);
  expect(document.body.textContent).not.toContain(w.createTitle);
  await fillSftpDestination();
}
async function fillSftpDestination() {
  await click(m.kindSftp, false);
  await edit(field(m.fieldName), destination.name);
  await edit(field(m.fieldHost), destination.sshHost!);
  await edit(field(m.fieldUser), destination.sshUser!);
  await edit(field(m.fieldPassword), "test-only-password");
  await edit(field(m.fieldPathPrefix), destination.pathPrefix!);
}
async function draftPolicy() {
  await toggleAdvanced();
  await click(w.methodPath, false);
  await edit(field(w.pathsLabel), "/data/uploads\n/data/reports");
  await click(w.presetWeekly);
  await edit(field(w.retainCount), "14");
}
function expectDraft() {
  expect(field(w.pathsLabel).value).toBe("/data/uploads\n/data/reports");
  expect(field(w.quick.customSchedule).value).toBe("17 3 * * 0");
  expect(field(w.retainCount).value).toBe("14");
}

async function toggleAdvanced() {
  const toggle = document.querySelector<HTMLButtonElement>(`button[aria-label="${w.advanced}"]`);
  expect(toggle).not.toBeNull();
  await act(async () => toggle!.click());
}

describe("backup policy destination creation", () => {
  it.each([false, true])(
    "creates and selects a destination without losing the policy draft (first destination: %s)",
    async (first) => {
      if (first) api.destinations.mockResolvedValue({ data: [] });
      await open();
      await draftPolicy();
      await addSftpDestination();
      await click(m.saveDestination);
      expect(api.createDestination).toHaveBeenCalledExactlyOnceWith({
        name: destination.name,
        kind: "sftp",
        sshHost: destination.sshHost,
        sshPort: 22,
        sshUser: destination.sshUser,
        sftpPassword: "test-only-password",
        pathPrefix: destination.pathPrefix,
      });
      expectDraft();
      expect(button(destination.name, false).textContent).toContain(destination.name);
      await openDestinationPicker();
      expect(document.querySelectorAll(`[role="option"][aria-selected="true"]`)).toHaveLength(1);
      expect(
        [...document.querySelectorAll('[role="option"]')].filter((node) =>
          node.textContent?.includes(destination.name),
        ),
      ).toHaveLength(1);
      await act(async () =>
        (document.querySelector('[role="option"][aria-selected="true"]') as HTMLElement).click(),
      );
      await click(w.createPolicy);
      expect(api.createPolicy).toHaveBeenCalledExactlyOnceWith(
        "project-1",
        expect.objectContaining({
          serviceId: "service-1",
          destinationId: destination.id,
          payloadKind: "path",
          payloadConfig: { paths: ["/data/uploads", "/data/reports"] },
          cronExpression: "17 3 * * 0",
          retainCount: 14,
        }),
      );
      expect(api.destinations).toHaveBeenCalledTimes(1);
    },
  );

  it("returns to the unchanged draft and selection when adding a destination is cancelled", async () => {
    await open();
    await draftPolicy();
    await addSftpDestination();
    await click(m.cancel);
    expectDraft();
    expect(button(previousDestination.name, false).textContent).toContain(previousDestination.name);
    expect(api.createDestination).not.toHaveBeenCalled();
    expect(api.close).not.toHaveBeenCalled();
  });

  it("keeps a failed destination save editable and selects it only after a successful retry", async () => {
    api.createDestination.mockRejectedValueOnce(new Error("Destination could not be saved"));
    await open();
    await draftPolicy();
    await addSftpDestination();
    await click(m.saveDestination);
    expect(document.body.textContent).toContain("Destination could not be saved");
    expect(field(m.fieldName).value).toBe(destination.name);
    expect(api.createPolicy).not.toHaveBeenCalled();
    await click(m.saveDestination);
    expectDraft();
    await click(w.createPolicy);
    expect(api.createPolicy).toHaveBeenCalledWith(
      "project-1",
      expect.objectContaining({ destinationId: destination.id }),
    );
  });

  it("keeps the new destination when an older list request finishes after creation", async () => {
    let resolve!: (value: { data: BackupDestinationSummary[] }) => void;
    api.destinations.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await open();
    await addSftpDestination();
    await click(m.saveDestination);
    await act(async () => resolve({ data: [previousDestination] }));
    expect(button(destination.name, false).textContent).toContain(destination.name);
    await click(w.createPolicy);
    expect(api.createPolicy).toHaveBeenCalledWith(
      "project-1",
      expect.objectContaining({ destinationId: destination.id }),
    );
  });

  it("keeps an in-flight destination save on its form until it can restore the policy draft", async () => {
    let resolve!: (value: { data: BackupDestinationSummary }) => void;
    api.createDestination.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await open();
    await draftPolicy();
    await addSftpDestination();
    const save = button(m.saveDestination);
    await act(async () => {
      save.click();
      save.click();
    });
    await act(async () => {
      document.querySelector<HTMLButtonElement>(`button[aria-label="${m.backToPicker}"]`)!.click();
    });
    // Switching forms during the request used to discard the fields and let its
    // eventual response replace a different destination choice.
    expect(field(m.fieldName).value).toBe(destination.name);
    expect(button(m.cancel).disabled).toBe(true);
    for (const close of document.querySelectorAll<HTMLButtonElement>(
      'button:has([data-icon="close"])',
    )) {
      await act(async () => close.click());
    }
    expect(field(m.fieldName).value).toBe(destination.name);
    await act(async () => resolve({ data: destination }));
    expectDraft();
    expect(button(destination.name, false).textContent).toContain(destination.name);
    expect(api.createDestination).toHaveBeenCalledTimes(1);
  });

  it("keeps destination creation unavailable while the policy itself is being saved", async () => {
    let resolve!: (value: { data: { id: string } }) => void;
    api.createPolicy.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await open();
    await draftPolicy();
    const save = button(w.createPolicy);
    await act(async () => {
      save.click();
      save.click();
    });
    await openDestinationPicker();
    const add = [...document.querySelectorAll("button")].find(
      (node) => node.textContent?.trim() === addDestination,
    );
    if (add) await act(async () => add.click());
    expect(document.body.textContent).not.toContain(m.modalAddTitle);
    expectDraft();
    await act(async () => resolve({ data: { id: "policy-1" } }));
    expect(api.saved).toHaveBeenCalledExactlyOnceWith({ id: "policy-1" });
    expect(api.createPolicy).toHaveBeenCalledTimes(1);
  });

  it("recovers a failed destination list without losing the draft", async () => {
    api.destinations.mockRejectedValueOnce(new Error("Destinations unavailable"));
    await open();
    await draftPolicy();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Destinations unavailable",
    );
    await click(w.retry);
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expectDraft();
    expect(button(previousDestination.name, false).textContent).toContain(previousDestination.name);
  });

  it.each([0, 1])(
    "opens the project/service policy editor from settings with no destinations (button %s)",
    async (index) => {
      api.destinations.mockResolvedValue({ data: [] });
      await open(true);
      const create = [...document.querySelectorAll("button")].filter(
        (node) => node.textContent?.trim() === w.createPolicy,
      );
      expect(create[index].disabled).toBe(false);
      await act(async () => create[index].click());
      expect(document.body.textContent).toContain(w.createTitle);
      await openDestinationPicker();
      await click(addDestination);
      expect(document.body.textContent).toContain(m.modalAddTitle);
    },
  );
});

const b = baseDictionary.projectSettings.backup;
function policy(patch: Partial<BackupPolicy> = {}): BackupPolicy {
  return {
    id: "policy-1",
    projectId: "project-1",
    serviceId: "service-1",
    destinationId: previousDestination.id,
    enabled: true,
    cronExpression: "17 3 * * *",
    triggerOnPreDeploy: false,
    webhookToken: null,
    webhookLastFiredAt: null,
    retainCount: 7,
    retainDays: null,
    payloadKind: "auto",
    payloadConfig: {},
    preHook: null,
    postHook: null,
    hookTimeoutSeconds: 60,
    compressionAlgo: "zstd",
    encryptionAtRest: true,
    createdBy: null,
    createdAt: "2026-09-25T00:00:00Z",
    updatedAt: "2026-09-25T00:00:00Z",
    ...patch,
  };
}
function run(patch: Partial<BackupRun> = {}): BackupRun {
  return {
    id: "run-1",
    policyId: "policy-1",
    destinationId: previousDestination.id,
    projectId: "project-1",
    serviceId: "service-1",
    userId: "user-1",
    status: "succeeded",
    triggeredBy: "manual",
    clientIp: null,
    startedAt: "2026-09-25T00:00:00Z",
    finishedAt: "2026-09-25T00:01:00Z",
    bytesTransferred: 1024,
    objectKeyPrefix: "backups/1",
    manifestKey: "backups/1/manifest.json",
    artifacts: [],
    errorMessage: null,
    ...patch,
  };
}

describe("project backup workspace", () => {
  it("shows and subscribes to every project backup without hiding another running policy", async () => {
    api.policies.mockResolvedValue({ data: [policy({ serviceId: null })] });
    const existing = run({ id: "other-run", policyId: "other-policy", status: "uploading", finishedAt: null });
    const first = run({ id: "batch-1", status: "queued", finishedAt: null });
    const second = run({ id: "batch-2", serviceId: "service-2", status: "queued", finishedAt: null });
    api.runs.mockResolvedValue({ data: [existing] });
    api.runNow.mockResolvedValue({ data: { runId: first.id, runIds: [first.id, second.id] } });
    const state = new Map([existing, first, second].map(run => [run.id, run]));
    api.stream.mockImplementation((id: string) => ({ run: state.get(id), connected: true, error: null }));
    await open(true);
    api.runs.mockResolvedValue({ data: [first, second, existing] });
    await click(b.services.backupNow);
    for (const id of state.keys()) expect(api.stream).toHaveBeenCalledWith(id);
    const live = document.querySelector(`section[aria-label="${b.live.title}"]`)!;
    expect(live.textContent).toContain("batch-1");
    expect(live.textContent).toContain("batch-2");
    expect(live.textContent).toContain("other-run");
    state.set(first.id, { ...first, status: "succeeded", finishedAt: "2026-09-25T00:02:00Z" });
    state.set(second.id, { ...second, status: "failed", errorMessage: "Storage unavailable" });
    const calls = api.runs.mock.calls.length;
    await open(true);
    // The live saved rows update the table without re-fetching its older,
    // still-queued history response or discarding expanded pages.
    expect(api.runs).toHaveBeenCalledTimes(calls);
    expect(document.querySelector("table")?.textContent).toContain("Storage unavailable");
    expect(document.querySelector("table")?.textContent).toContain(b.recent.restore);
    expect(live.textContent).toContain("Storage unavailable");
    await click(b.live.dismiss);
    expect(document.querySelector(`section[aria-label="${b.live.title}"]`)?.hasAttribute("hidden")).toBe(true);
  });

  it("adds storage directly in the project and selects it for the next policy", async () => {
    const location = window.location.href;
    await open(true);
    await click(m.addDestination);
    await fillSftpDestination();
    await click(m.saveDestination);
    expect(window.location.href).toBe(location);
    expect(document.querySelector("aside")?.textContent).toContain(destination.name);
    expect(document.body.textContent).not.toContain(m.modalAddTitle);
    await click(b.services.createPolicy);
    await openDestinationPicker();
    const selected = document.querySelector<HTMLElement>('[role="option"][aria-selected="true"]');
    expect(selected?.textContent).toContain(destination.name);
    await act(async () => selected!.click());
    const save = [...document.querySelectorAll("button")]
      .filter((node) => node.textContent?.trim() === w.createPolicy)
      .at(-1)!;
    await act(async () => save.click());
    expect(api.createPolicy).toHaveBeenCalledWith(
      "project-1",
      expect.objectContaining({ destinationId: destination.id, serviceId: null }),
    );
  });

  it("retains storage created inside a policy even when the policy draft is cancelled", async () => {
    await open(true);
    await click(b.services.createPolicy);
    await addSftpDestination();
    await click(m.saveDestination);
    await click(w.cancel);
    expect(document.querySelector("aside")?.textContent).toContain(destination.name);
    expect(api.createPolicy).not.toHaveBeenCalled();
  });

  it("edits a saved destination in place without resending its stored secret", async () => {
    api.updateDestination.mockResolvedValue({
      data: { ...previousDestination, name: "Updated archive" },
    });
    await open(true);
    await click(previousDestination.name);
    expect(field(m.fieldPassword).value).toBe("");
    await edit(field(m.fieldName), "Updated archive");
    await click(m.saveChanges);
    expect(api.updateDestination).toHaveBeenCalledWith(
      previousDestination.id,
      expect.objectContaining({ name: "Updated archive" }),
    );
    expect(api.updateDestination.mock.calls[0][1]).not.toHaveProperty("sftpPassword");
    expect(document.querySelector("aside")?.textContent).toContain("Updated archive");
  });

  it("does not let an older refresh remove newly saved storage", async () => {
    let resolve!: (value: { data: BackupDestinationSummary[] }) => void;
    await open(true);
    api.destinations.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await click(b.services.refresh);
    await click(m.addDestination);
    await fillSftpDestination();
    await click(m.saveDestination);
    await act(async () => resolve({ data: [previousDestination] }));
    expect(document.querySelector("aside")?.textContent).toContain(destination.name);
  });

  it("reports an unavailable backup history and recovers instead of showing a false empty state", async () => {
    api.runs.mockRejectedValueOnce(new Error("History unavailable"));
    await open(true);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("History unavailable");
    expect(document.body.textContent).not.toContain(b.recent.empty);
    await click(w.retry);
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(document.body.textContent).toContain(b.recent.empty);
  });

  it("shows every service policy with readable schedules and counts only enabled schedules", async () => {
    api.policies.mockResolvedValue({
      data: [policy(), policy({ id: "policy-2", enabled: false })],
    });
    await open(true);
    expect(
      [...document.querySelectorAll("button")].filter(
        (node) => node.textContent?.trim() === b.services.backupNow,
      ),
    ).toHaveLength(2);
    expect(document.body.textContent).toContain("Daily at 03:17");
    expect(document.body.textContent).toContain(b.overview.paused);
    const metric = [...document.querySelectorAll("dt")].find((node) =>
      node.textContent?.includes(b.overview.scheduledPolicies),
    );
    expect(metric?.nextElementSibling?.textContent).toBe("1");
    expect(document.body.textContent).not.toContain("Chunk 2");
  });

  it("shows a failed connection check even if storage was verified before", async () => {
    api.destinations.mockResolvedValue({
      data: [
        {
          ...previousDestination,
          lastVerifiedAt: "2026-09-24T00:00:00Z",
          lastVerifyError: "Connection refused",
        },
      ],
    });
    await open(true);
    expect(document.querySelector("aside")?.textContent).toContain(m.failedBadge);
    expect(document.querySelector("aside")?.textContent).not.toContain(m.verifiedBadge);
  });

  it("submits a backup only once and updates history in place when its live run completes", async () => {
    let resolve!: (value: { data: { runId: string } }) => void;
    api.policies.mockResolvedValue({ data: [policy()] });
    api.runNow.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await open(true);
    const trigger = button(b.services.backupNow);
    await act(async () => {
      trigger.click();
      trigger.click();
    });
    expect(api.runNow).toHaveBeenCalledExactlyOnceWith("policy-1");
    await act(async () => resolve({ data: { runId: "run-1" } }));
    const callsBeforeComplete = api.runs.mock.calls.length;
    const completed = run();
    api.runs.mockResolvedValue({ data: [completed] });
    api.stream.mockReturnValue({ run: completed, connected: false, error: null });
    await open(true);
    expect(api.runs).toHaveBeenCalledTimes(callsBeforeComplete);
    expect(document.querySelector("table")?.textContent).toContain(b.recent.restore);
    await open(true);
    expect(api.runs).toHaveBeenCalledTimes(callsBeforeComplete);
  });
});

describe("simple backup presets", () => {
  const q = w.quick;

  it("saves incremental capture as an explicit choice and preserves other stored options", async () => {
    await open(false, { existing: policy({ payloadKind: "volume", payloadConfig: {
      compression: "gzip", exclude: ["cache"], sourceIds: ["data"], quiesce: true,
    } }) });
    const toggle = () => document.querySelector<HTMLInputElement>(`input[aria-label="${w.incrementalLabel}"]`)!;
    if (!toggle()) await toggleAdvanced();
    expect(toggle().checked).toBe(false);
    await act(async () => toggle().click());
    await click(w.saveChanges);
    expect(api.updatePolicy).toHaveBeenCalledWith("policy-1", expect.objectContaining({
      payloadConfig: { compression: "gzip", exclude: ["cache"], sourceIds: ["data"], quiesce: true, incremental: true },
    }));
  });

  it("can switch back to full backups without discarding unrelated settings", async () => {
    await open(false, { existing: policy({ payloadKind: "auto", payloadConfig: {
      incremental: true, compression: "gzip", exclude: ["cache"], verifyOnPrepare: true,
    } }) });
    let toggle = document.querySelector<HTMLInputElement>(`input[aria-label="${w.incrementalLabel}"]`);
    if (!toggle) { await toggleAdvanced(); toggle = document.querySelector(`input[aria-label="${w.incrementalLabel}"]`); }
    expect(toggle!.checked).toBe(true);
    await act(async () => toggle!.click());
    await click(w.saveChanges);
    expect(api.updatePolicy).toHaveBeenCalledWith("policy-1", expect.objectContaining({
      payloadConfig: { compression: "gzip", exclude: ["cache"], verifyOnPrepare: true },
    }));
  });

  async function choose(label: string, option: string) {
    const trigger = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    expect(trigger).not.toBeNull();
    await act(async () => trigger!.click());
    const selected = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (node) => node.textContent?.trim() === option,
    );
    expect(selected, option).toBeDefined();
    await act(async () => selected!.click());
  }

  it("creates a service-volume policy with one save and sensible defaults", async () => {
    const preferred = { ...destination, isDefault: true };
    api.destinations.mockResolvedValue({ data: [previousDestination, preferred] });
    await open(false, { serviceImage: "nginx:alpine", serviceName: "Uploads" });
    expect(document.body.textContent).toContain(q.volumesTitle);
    expect(document.body.textContent).toContain(q.onDemand);
    expect(document.querySelector("textarea")).toBeNull();
    expect(
      document.querySelector(`button[aria-label="${w.advanced}"]`)?.getAttribute("aria-expanded"),
    ).toBe("false");
    await click(w.createPolicy);
    expect(api.createPolicy).toHaveBeenCalledExactlyOnceWith(
      "project-1",
      expect.objectContaining({
        serviceId: "service-1",
        destinationId: preferred.id,
        payloadKind: "volume",
        payloadConfig: {},
        cronExpression: null,
        retainCount: 7,
        retainDays: null,
        preHook: null,
        postHook: null,
        triggerOnPreDeploy: false,
        enabled: true,
      }),
    );
    expect(api.runNow).not.toHaveBeenCalled();
  });

  it.each([
    ["postgres:17", "pg_dump"],
    ["mysql:8", "mysql_dump"],
    ["mongo:8", "mongo_dump"],
    ["redis:7", "redis_rdb"],
  ])(
    "uses the database backup tool for %s instead of a live volume copy",
    async (serviceImage, payloadKind) => {
      await open(false, { serviceImage });
      expect(document.body.textContent).toContain(q.databaseDescription);
      await click(w.createPolicy);
      expect(api.createPolicy).toHaveBeenCalledWith(
        "project-1",
        expect.objectContaining({ payloadKind }),
      );
    },
  );

  it("keeps project backups automatic per service", async () => {
    await open(false, { serviceId: null });
    expect(document.body.textContent).toContain(q.projectDescription);
    await click(w.createPolicy);
    expect(api.createPolicy).toHaveBeenCalledWith(
      "project-1",
      expect.objectContaining({
        serviceId: null,
        payloadKind: "auto",
        retainCount: 7,
      }),
    );
  });

  it("changes schedule and history presets without opening Advanced", async () => {
    await open();
    await choose(q.frequency, w.presetDaily);
    await choose(q.history, "Last 14 backups");
    expect(document.querySelector("textarea")).toBeNull();
    await click(w.createPolicy);
    expect(api.createPolicy).toHaveBeenCalledWith(
      "project-1",
      expect.objectContaining({
        cronExpression: "17 3 * * *",
        retainCount: 14,
        retainDays: null,
      }),
    );
  });

  it("keeps a customized draft when Advanced is collapsed", async () => {
    await open();
    await draftPolicy();
    await toggleAdvanced();
    expect(document.querySelector("textarea")).toBeNull();
    await click(w.createPolicy);
    expect(api.createPolicy).toHaveBeenCalledWith(
      "project-1",
      expect.objectContaining({
        payloadKind: "path",
        payloadConfig: { paths: ["/data/uploads", "/data/reports"] },
        cronExpression: "17 3 * * 0",
        retainCount: 14,
      }),
    );
  });

  it("preserves a saved custom policy without opening Advanced", async () => {
    const existing = policy({
      payloadKind: "path",
      payloadConfig: {
        paths: ["/srv/reports"],
        exclude: ["./cache"],
        compression: "gzip",
        clearPath: true,
        artifactName: "reports",
      },
      cronExpression: "5 2 * * 1-5",
      retainCount: null,
      retainDays: 90,
      preHook: "sync",
      postHook: "true",
      triggerOnPreDeploy: true,
      webhookToken: "test-hook-token",
      enabled: false,
    });
    await open(false, { existing });
    expect(document.querySelector("textarea")).toBeNull();
    expect(document.body.textContent).toContain(q.customSchedule);
    expect(document.body.textContent).toContain(q.customRetention);
    await click(w.saveChanges);
    expect(api.updatePolicy).toHaveBeenCalledExactlyOnceWith(
      existing.id,
      expect.objectContaining({
        payloadKind: existing.payloadKind,
        payloadConfig: existing.payloadConfig,
        cronExpression: existing.cronExpression,
        retainCount: null,
        retainDays: 90,
        preHook: existing.preHook,
        postHook: existing.postHook,
        triggerOnPreDeploy: true,
        enableWebhook: true,
        enabled: false,
      }),
    );
    expect(api.createPolicy).not.toHaveBeenCalled();
  });

  it("does not replace an existing unlimited history with the seven-backup default", async () => {
    await open(false, { existing: policy({ retainCount: null, retainDays: null }) });
    await click(w.saveChanges);
    expect(api.updatePolicy).toHaveBeenCalledWith(
      "policy-1",
      expect.objectContaining({
        retainCount: null,
        retainDays: null,
      }),
    );
  });

  it("shows validation inline and opens the relevant advanced fields", async () => {
    await open();
    await toggleAdvanced();
    await click(w.methodPath, false);
    await toggleAdvanced();
    await click(w.createPolicy);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(w.pathsRequired);
    expect(field(w.pathsLabel)).toBeDefined();
    expect(api.createPolicy).not.toHaveBeenCalled();
  });

  it("saves only when the create-policy action is chosen", async () => {
    await open(false, { onSavedAndRun: api.savedAndRun });
    await click(w.createPolicy);
    expect(api.saved).toHaveBeenCalledOnce();
    expect(api.savedAndRun).not.toHaveBeenCalled();
  });

  it("saves and starts the first backup once even after a double click", async () => {
    let resolve!: (value: { data: BackupPolicy }) => void;
    api.createPolicy.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await open(false, { onSavedAndRun: api.savedAndRun });
    const start = button(q.saveAndBackup);
    await act(async () => {
      start.click();
      start.click();
    });
    expect(api.createPolicy).toHaveBeenCalledOnce();
    const saved = policy({ payloadKind: "volume" });
    await act(async () => resolve({ data: saved }));
    expect(api.savedAndRun).toHaveBeenCalledExactlyOnceWith(saved);
    expect(api.saved).not.toHaveBeenCalled();
  });

  it("keeps a failed save editable without starting a backup", async () => {
    api.createPolicy.mockRejectedValueOnce(new Error("Storage is unavailable"));
    await open(false, { onSavedAndRun: api.savedAndRun });
    await click(q.saveAndBackup);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Storage is unavailable",
    );
    expect(api.savedAndRun).not.toHaveBeenCalled();
    await click(q.saveAndBackup);
    expect(api.savedAndRun).toHaveBeenCalledOnce();
  });

  it("uses the saved project policy for the first backup and reuses it after a queue failure", async () => {
    let saved: BackupPolicy | null = null;
    api.createPolicy.mockImplementation(async (projectId, input) => {
      saved = policy({ ...input, projectId });
      return { data: saved };
    });
    api.policies.mockImplementation(async () => ({ data: saved ? [saved] : [] }));
    api.runNow.mockRejectedValueOnce(new Error("Backup queue is unavailable"));
    await open(true);
    await click(b.services.createPolicy);
    await click(q.saveAndBackup);
    expect(api.createPolicy).toHaveBeenCalledOnce();
    expect(api.runNow).toHaveBeenCalledExactlyOnceWith("policy-1");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Backup queue is unavailable",
    );
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await click(b.services.backupNow);
    expect(api.createPolicy).toHaveBeenCalledOnce();
    expect(api.runNow).toHaveBeenCalledTimes(2);
  });

  it("keeps a newly saved policy available when refreshing the history fails", async () => {
    const saved = policy({ serviceId: null, payloadKind: "auto" });
    api.createPolicy.mockResolvedValue({ data: saved });
    await open(true);
    api.runs.mockRejectedValueOnce(new Error("History temporarily unavailable"));
    await click(b.services.createPolicy);
    const save = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
      (node) => node.textContent?.trim() === w.createPolicy,
    );
    await act(async () => save!.click());
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "History temporarily unavailable",
    );
    expect(button(b.services.backupNow)).toBeDefined();
    expect(api.createPolicy).toHaveBeenCalledOnce();
    expect(api.runNow).not.toHaveBeenCalled();
  });
});
