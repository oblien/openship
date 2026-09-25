// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
import { baseDictionary } from "@/i18n";
import { ApiError, type BackupDestinationSummary } from "@/lib/api";
import type { BackupDestinationRun } from "@repo/contracts";
import BackupsPage from "./page";
import DestinationPage from "./[id]/page";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  usage: vi.fn(),
  history: vi.fn(),
  runs: vi.fn(),
  getRun: vi.fn(),
  toast: vi.fn(),
  params: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useParams: mocks.params }));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ showToast: mocks.toast }) }));
vi.mock("@/components/backup/CreateDestinationModal", () => ({
  CreateDestinationModal: () => null,
}));
vi.mock("@/components/backup/BackupRunCard", () => ({
  BackupRunCard: ({ runId }: { runId: string }) => <div data-run={runId} />,
}));
vi.mock("@/components/backup/RestoreWizard", () => ({
  RestoreWizard: ({
    sourceRun,
    serviceName,
  }: {
    sourceRun: { id: string };
    serviceName: string;
  }) => <div data-restore={sourceRun.id}>{serviceName}</div>,
}));
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    backupDestinationsApi: {
      ...actual.backupDestinationsApi,
      list: mocks.list,
      usage: mocks.usage,
      history: mocks.history,
      runs: mocks.runs,
    },
    backupsApi: { ...actual.backupsApi, getRun: mocks.getRun },
  };
});

const m = baseDictionary.misc.backups;
const b = baseDictionary.projectSettings.backup;
let root: Root;
let host: HTMLDivElement;
let destination: BackupDestinationSummary;
let records: BackupDestinationRun[];
let id: string;
const row = (id: string, serviceName: string, bytes: number): BackupDestinationRun => ({
  id,
  destinationId: "storage",
  destinationName: "Production backups",
  projectId: "project",
  projectName: "Openship",
  serviceId: serviceName,
  serviceName,
  mailServerId: null,
  mailServerName: null,
  sourceKind: "service",
  status: "succeeded",
  triggeredBy: "manual",
  startedAt: "2026-09-25T11:04:49.604Z",
  finishedAt: "2026-09-25T11:06:00.042Z",
  bytesTransferred: bytes,
  errorMessage: null,
  payloads: [
    {
      kind: serviceName === "postgres" ? "pg_dump" : "redis",
      volumeTarget: null,
      incremental: false,
    },
  ],
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const render = (detail = false) =>
  act(async () =>
    root.render(<I18nProvider>{detail ? <DestinationPage /> : <BackupsPage />}</I18nProvider>),
  );
const tableRows = () => [...host.querySelectorAll<HTMLTableRowElement>("tbody tr")];
function button(label: string) {
  const result = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.trim() === label || button.getAttribute("aria-label") === label,
  );
  expect(result, label).toBeDefined();
  return result!;
}
const click = (label: string) => act(async () => button(label).click());
function stat(label: string) {
  const term = [...host.querySelectorAll("dt")].find((item) => item.textContent === label);
  return term?.parentElement?.querySelector("dd")?.textContent;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  id = "storage";
  mocks.params.mockImplementation(() => ({ id }));
  destination = {
    id,
    name: "Production backups",
    kind: "openship_server",
    serverId: "server",
    pathPrefix: "/backups",
    isDefault: true,
    lastVerifiedAt: "2026-09-25T11:00:00Z",
    lastVerifyError: null,
    stats: {
      storedBytes: 54_568_793,
      runCount: 2,
      savedCount: 2,
      activeCount: 0,
      failedCount: 0,
      cancelledCount: 0,
      lastRunAt: "2026-09-25T11:04:49.604Z",
    },
  } as BackupDestinationSummary;
  records = [row("redis-run", "redis", 119_743), row("postgres-run", "postgres", 54_449_050)];
  mocks.list.mockImplementation(async () => ({ data: [destination] }));
  mocks.usage.mockImplementation(async () => ({ data: { destination, policies: [] } }));
  mocks.history.mockImplementation(
    async ({ limit = 10, before }: { limit?: number; before?: string } = {}) => {
      const start = before ? records.findIndex((run) => run.id === before) + 1 : 0;
      const runs = records.slice(start, start + limit);
      return {
        data: { runs, nextCursor: start + limit < records.length ? runs.at(-1)!.id : null },
      };
    },
  );
  mocks.runs.mockImplementation((_id, options) => mocks.history(options));
  mocks.getRun.mockImplementation(async (id) => ({
    data: { ...records.find((run) => run.id === id), artifacts: [] },
  }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([false, true])(
  "keeps saved totals after policy removal and shows history only on the overview (detail=%s)",
  async (detail) => {
    await render(detail);
    expect(stat(m.summaryStored)).toBe("52.0 MB");
    expect(stat(m.summaryBackups)).toBe("2");
    if (detail) {
      expect(host.textContent).toContain(m.noUsageTitle);
      expect(tableRows()).toHaveLength(0);
      expect(mocks.history).not.toHaveBeenCalled();
      expect(mocks.runs).not.toHaveBeenCalled();
    } else {
      expect(tableRows()).toHaveLength(2);
      expect(tableRows()[0].textContent).toContain("redis");
      expect(tableRows()[0].textContent).toContain("116.9 KB");
      expect(tableRows()[1].textContent).toContain("postgres");
      expect(tableRows()[1].textContent).toContain("51.9 MB");
      expect(tableRows().every((row) => row.textContent?.includes("Succeeded"))).toBe(true);
    }
  },
);

it.each([false, true])(
  "keeps a newer failed connection check visible despite its old success (detail=%s)",
  async (detail) => {
    destination.lastVerifyError = "Connection refused";
    destination.stats = {
      ...destination.stats!,
      runCount: 8,
      failedCount: 4,
      activeCount: 1,
      cancelledCount: 1,
    };
    await render(detail);
    expect(host.textContent).toContain("Connection refused");
    expect(host.textContent).not.toContain(m.verifiedBadge);
    expect(stat(m.summaryBackups)).toBe("2");
    expect(stat(m.summaryFailed)).toBe("4");
    expect(stat(m.summaryActive)).toBe("1");
    expect(stat(m.summaryCancelled)).toBe("1");
  },
);

it("does not turn a failed list request into an empty destination list and recovers through Retry", async () => {
  mocks.list.mockRejectedValueOnce(
    new ApiError(503, "Unavailable", { error: "Database is temporarily unavailable" }),
  );
  await render();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "Database is temporarily unavailable",
  );
  expect(host.textContent).not.toContain(m.emptyTitle);
  await click(baseDictionary.chrome.apiDown.retry);
  expect(tableRows()).toHaveLength(2);
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

it("reports failed detail refreshes without replacing existing data or claiming the destination disappeared", async () => {
  await render(true);
  mocks.usage.mockRejectedValueOnce(new ApiError(503, "Unavailable", { error: "Try again later" }));
  await click(b.services.refresh);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Try again later");
  expect(host.textContent).toContain(destination.name);
  expect(host.textContent).not.toContain(m.notFound);
  expect(stat(m.summaryBackups)).toBe("2");
  await click(baseDictionary.chrome.apiDown.retry);
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

it("shows not-found only for a real 404", async () => {
  mocks.usage.mockRejectedValue(new ApiError(404, "Not found", { error: "Not found" }));
  await render(true);
  expect(host.textContent).toContain(m.notFound);
  expect(mocks.runs).not.toHaveBeenCalled();
});

it("ignores a previous destination's late response after navigation", async () => {
  const pending = deferred<{ data: { destination: BackupDestinationSummary; policies: [] } }>();
  mocks.usage.mockReturnValueOnce(pending.promise);
  await render(true);
  const previous = destination;
  id = "other-storage";
  destination = { ...destination, id, name: "Other storage" };
  await render(true);
  expect(host.querySelector("h1")?.textContent).toBe("Other storage");
  await act(async () => pending.resolve({ data: { destination: previous, policies: [] } }));
  expect(host.querySelector("h1")?.textContent).toBe("Other storage");
});

it("paginates without duplicates and refreshes the current page rather than jumping back", async () => {
  records = Array.from({ length: 12 }, (_, index) => row(`run-${index}`, `service-${index}`, 100));
  await render();
  expect(tableRows()).toHaveLength(10);
  await click(baseDictionary.deployments.pagination.next);
  expect(tableRows()).toHaveLength(2);
  expect(tableRows()[0].textContent).toContain("service-10");
  await click(b.services.refresh);
  expect(tableRows()).toHaveLength(2);
  expect(mocks.history).toHaveBeenLastCalledWith({ limit: 10, before: "run-9" });
  await click(baseDictionary.deployments.pagination.previous);
  expect(tableRows()).toHaveLength(10);
  expect(tableRows()[0].textContent).toContain("service-0");
});

it("polls active runs without overlapping reads, skips hidden tabs, and stops after completion", async () => {
  destination.stats = { ...destination.stats!, activeCount: 1 };
  await render();
  const pending = deferred<{ data: BackupDestinationSummary[] }>();
  mocks.list.mockReturnValueOnce(pending.promise);
  await act(async () => vi.advanceTimersByTimeAsync(45_000));
  expect(mocks.list).toHaveBeenCalledTimes(2);
  await act(async () => pending.resolve({ data: [destination] }));
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(mocks.list).toHaveBeenCalledTimes(2);
  destination = { ...destination, stats: { ...destination.stats!, activeCount: 0 } };
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(stat(m.summaryActive)).toBeUndefined();
  const calls = mocks.list.mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(mocks.list).toHaveBeenCalledTimes(calls);
});

it("opens the existing restore wizard for the exact backup, with one guarded read", async () => {
  const pending = deferred<{ data: { id: string; artifacts: [] } }>();
  mocks.getRun.mockReturnValueOnce(pending.promise);
  await render();
  const restore = [...tableRows()[1].querySelectorAll("button")].find((button) =>
    button.textContent?.includes(b.recent.restore),
  )!;
  await act(async () => {
    restore.click();
    restore.click();
  });
  expect(mocks.getRun).toHaveBeenCalledExactlyOnceWith("postgres-run");
  expect(restore.disabled).toBe(true);
  await act(async () => pending.resolve({ data: { id: "postgres-run", artifacts: [] } }));
  expect(host.querySelector('[data-restore="postgres-run"]')?.textContent).toBe("postgres");
});

it("never mistakes legacy attempt totals for saved backups", async () => {
  destination.stats = { storedBytes: 10, runCount: 8, lastRunAt: null };
  await render();
  expect(stat(m.summaryBackups)).toBe("—");
  expect(host.textContent).toContain(`8 ${m.statsRuns}`);
});
