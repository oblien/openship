// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
import { baseDictionary } from "@/i18n";
import type { BackupPolicy, BackupRun } from "@/lib/api";
import { BackupSettings } from "./BackupSettings";

const mocks = vi.hoisted(() => ({
  context: vi.fn(),
  runs: vi.fn(),
  policies: vi.fn(),
  destinations: vi.fn(),
  stream: vi.fn(),
}));
vi.mock("@/context/ProjectSettingsContext", () => ({ useProjectSettings: mocks.context }));
vi.mock("@/hooks/useBackupRunStream", () => ({ useBackupRunStream: mocks.stream }));
vi.mock("@/components/backup/CreateDestinationModal", () => ({
  CreateDestinationModal: () => null,
}));
vi.mock("@/components/backup/PolicyEditor", () => ({ PolicyEditor: () => null }));
vi.mock("@/components/backup/RestoreWizard", () => ({ RestoreWizard: () => null }));
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    backupsApi: { ...actual.backupsApi, listRuns: mocks.runs, listPolicies: mocks.policies },
    backupDestinationsApi: { ...actual.backupDestinationsApi, list: mocks.destinations },
  };
});
const b = baseDictionary.projectSettings.backup;
let project: string;
let saved: BackupRun[];
let live: Map<string, BackupRun>;
let root: Root;
let host: HTMLDivElement;
const render = () =>
  act(async () =>
    root.render(
      <I18nProvider>
        <BackupSettings />
      </I18nProvider>,
    ),
  );
const row = (n: number, projectId = "project"): BackupRun => ({
  id: `run-${n}`,
  projectId,
  policyId: "policy",
  destinationId: null,
  serviceId: "postgres",
  userId: "tester",
  clientIp: null,
  objectKeyPrefix: null,
  manifestKey: null,
  status: "succeeded",
  startedAt: new Date(Date.parse("2026-09-25T11:00:00Z") + n * 1000).toISOString(),
  finishedAt: "2026-09-25T11:05:00Z",
  lastEventAt: "2026-09-25T11:05:00Z",
  triggeredBy: "manual",
  bytesTransferred: 1024,
  artifacts: [],
  errorMessage: null,
});
const history = () => host.querySelector<HTMLElement>(`section[aria-label="${b.recent.title}"]`)!;
const rows = () => history().querySelectorAll("tbody tr");
function button(text: string) {
  const result = [...host.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === text,
  );
  expect(result, text).toBeDefined();
  return result!;
}
const click = (text: string) => act(async () => button(text).click());
const details = () =>
  history().querySelector<HTMLButtonElement>(`button[title="${b.recent.viewDetails}"]`)!;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  project = "project";
  saved = Array.from({ length: 23 }, (_, i) => row(23 - i));
  live = new Map();
  mocks.context.mockImplementation(() => ({
    projectData: { id: project },
    servicesData: { services: [{ id: "postgres", name: "Postgres", image: "postgres:17" }] },
  }));
  mocks.stream.mockImplementation((id: string) => ({
    run: live.get(id) ?? null,
    connected: false,
    reconnecting: false,
    error: null,
    reconnect: () => {},
  }));
  mocks.destinations.mockResolvedValue({ data: [] });
  mocks.policies.mockResolvedValue({
    data: [
      {
        id: "policy",
        projectId: "project",
        serviceId: null,
        enabled: true,
        cronExpression: null,
        payloadKind: "auto",
        retainCount: 7,
        retainDays: null,
      } as BackupPolicy,
    ],
  });
  mocks.runs.mockImplementation(
    async (_project: string, opts: { limit: number; before?: string; active?: boolean }) => {
      if (opts.active)
        return {
          data: saved.filter(
            (run) => !["succeeded", "failed", "cancelled", "server_error"].includes(run.status),
          ),
        };
      const start = opts.before ? saved.findIndex((run) => run.id === opts.before) + 1 : 0;
      return { data: saved.slice(start, start + opts.limit) };
    },
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("shows recent backups beside destinations before policies and loads bounded pages until history ends", async () => {
  await render();
  expect(rows().length).toBe(10);
  const destinations = host.querySelector(`aside[aria-label="${b.destinations.title}"]`)!;
  const policies = host.querySelector(`section[aria-label="${b.services.title}"]`)!;
  expect(
    history().compareDocumentPosition(destinations) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    destinations.compareDocumentPosition(policies) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(mocks.runs).toHaveBeenCalledWith("project", { limit: 11 });
  expect(mocks.runs).toHaveBeenCalledWith("project", { active: true, limit: 1000 });
  await click(b.recent.loadOlder);
  expect(mocks.runs).toHaveBeenLastCalledWith("project", { limit: 11, before: "run-14" });
  expect(rows().length).toBe(20);
  await click(b.recent.loadOlder);
  expect(mocks.runs).toHaveBeenLastCalledWith("project", { limit: 11, before: "run-4" });
  expect(rows().length).toBe(23);
  expect(host.textContent).not.toContain(b.recent.loadOlder);
});

it("keeps the visible history on a page failure and retries the same cursor without duplicate requests", async () => {
  await render();
  const page = deferred<{ data: BackupRun[] }>();
  mocks.runs.mockReturnValueOnce(page.promise);
  await act(async () => {
    button(b.recent.loadOlder).click();
    button(b.recent.loadOlder).click();
  });
  expect(mocks.runs).toHaveBeenCalledTimes(3);
  await act(async () => page.reject(new Error("Server disconnected")));
  expect(rows().length).toBe(10);
  expect(history().querySelector('[role="alert"]')?.textContent).toBe("Server disconnected");
  await click(b.recent.loadOlder);
  expect(mocks.runs).toHaveBeenLastCalledWith("project", { limit: 11, before: "run-14" });
  expect(rows().length).toBe(20);
  expect(history().querySelector('[role="alert"]')).toBeNull();
});

it("does not append an older page after refreshing the recent list", async () => {
  await render();
  const page = deferred<{ data: BackupRun[] }>();
  mocks.runs.mockReturnValueOnce(page.promise);
  await click(b.recent.loadOlder);
  await click(b.services.refresh);
  await act(async () => page.resolve({ data: saved.slice(10, 21) }));
  expect(rows().length).toBe(10);
  expect(button(b.recent.loadOlder).disabled).toBe(false);
});

it("discards pending history from a project that is no longer open", async () => {
  await render();
  const page = deferred<{ data: BackupRun[] }>();
  mocks.runs.mockReturnValueOnce(page.promise);
  await click(b.recent.loadOlder);
  const oldPage = saved.slice(10, 21);
  project = "other-project";
  saved = [row(99, project)];
  await render();
  expect(rows().length).toBe(1);
  await act(async () => page.resolve({ data: oldPage }));
  expect(rows().length).toBe(1);
  expect(mocks.runs).toHaveBeenCalledWith("other-project", { limit: 11 });
});

it("updates the table and releases policy controls when live capture finishes without collapsing expanded history", async () => {
  saved[0] = { ...saved[0], status: "preparing", finishedAt: null };
  await render();
  await click(b.recent.loadOlder);
  expect(button(b.services.backupNow).disabled).toBe(true);
  live.set(saved[0].id, {
    ...saved[0],
    status: "succeeded",
    finishedAt: "2026-09-25T11:06:00Z",
    lastEventAt: "2026-09-25T11:06:00Z",
  });
  await render();
  expect(rows().length).toBe(20);
  expect(rows()[0].textContent).toContain(baseDictionary.widgets.backup.runCard.status.succeeded);
  expect(button(b.services.backupNow).disabled).toBe(false);
  expect(mocks.runs).toHaveBeenCalledTimes(3);
});

it("can reopen details after dismissing them", async () => {
  await render();
  await act(async () => details().click());
  expect(host.querySelector(`section[aria-label="${b.live.title}"]`)).not.toBeNull();
  await click(b.live.dismiss);
  expect(host.querySelector(`section[aria-label="${b.live.title}"]`)).toBeNull();
  await act(async () => details().click());
  expect(host.querySelector(`section[aria-label="${b.live.title}"]`)).not.toBeNull();
});

it("tracks an active run outside the first history page, even while its details are dismissed", async () => {
  const old = { ...saved[20], status: "uploading" as const, finishedAt: null };
  saved[20] = old;
  await render();
  expect(rows().length).toBe(10);
  expect(mocks.stream).toHaveBeenCalledWith(old.id);
  expect(button(b.services.backupNow).disabled).toBe(true);
  await click(b.live.dismiss);
  expect(host.querySelector(`section[aria-label="${b.live.title}"]`)?.hasAttribute("hidden")).toBe(
    true,
  );
  live.set(old.id, {
    ...old,
    status: "succeeded",
    finishedAt: "2026-09-25T11:06:00Z",
    lastEventAt: "2026-09-25T11:06:00Z",
  });
  await render();
  expect(button(b.services.backupNow).disabled).toBe(false);
  expect(host.querySelector(`section[aria-label="${b.live.title}"]`)).toBeNull();
  expect(rows().length).toBe(10);
  expect(mocks.runs).toHaveBeenCalledTimes(2);
  // The older page can race the stream. Its old uploading row must not undo
  // the already observed terminal result or produce a duplicate history row.
  await click(b.recent.loadOlder);
  await click(b.recent.loadOlder);
  expect(rows().length).toBe(23);
  expect(rows()[20].textContent).toContain(baseDictionary.widgets.backup.runCard.status.succeeded);
});
