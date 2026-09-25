// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
import { baseDictionary } from "@/i18n";
import type { BackupRun } from "@/lib/api";
import type { UseBackupRunStreamResult } from "@/hooks/useBackupRunStream";
import { BackupRunCard } from "./BackupRunCard";

const mocks = vi.hoisted(() => ({ stream: vi.fn(), complete: vi.fn(), update: vi.fn() }));
vi.mock("@/hooks/useBackupRunStream", () => ({ useBackupRunStream: mocks.stream }));
const w = baseDictionary.widgets.backup.runCard;
const start = "2026-09-25T11:04:49.604Z";
const initial: BackupRun = {
  id: "backup-one",
  projectId: "project",
  policyId: null,
  destinationId: null,
  serviceId: "postgres",
  userId: "tester",
  clientIp: null,
  objectKeyPrefix: null,
  manifestKey: null,
  status: "preparing",
  triggeredBy: "manual",
  startedAt: start,
  lastEventAt: start,
  finishedAt: null,
  bytesTransferred: null,
  artifacts: [],
  errorMessage: null,
};
let live: UseBackupRunStreamResult;
let root: Root;
let host: HTMLDivElement;
const render = (snapshot: BackupRun = initial, visible = true) =>
  act(async () =>
    root.render(
      <I18nProvider>
        <BackupRunCard
          runId="backup-one"
          initial={snapshot}
          serviceName="Postgres"
          visible={visible}
          onComplete={mocks.complete}
          onUpdate={mocks.update}
        />
      </I18nProvider>,
    ),
  );

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(start));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  live = { run: null, connected: true, reconnecting: false, error: null, reconnect: vi.fn() };
  mocks.stream.mockImplementation(() => live);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("advances elapsed time while preparation has no new events", async () => {
  await render();
  expect(host.textContent).toContain("0s");
  await act(async () => vi.advanceTimersByTimeAsync(21_000));
  expect(host.textContent).toContain("21s");
  expect(host.textContent).toContain(w.phase.preparing);
  expect(mocks.update).toHaveBeenCalledOnce();
  expect(mocks.complete).not.toHaveBeenCalled();
});

it("uses the saved final timestamps and bytes instead of an older connected stream", async () => {
  live.run = initial;
  await render();
  const finished: BackupRun = {
    ...initial,
    status: "succeeded",
    bytesTransferred: 54_449_050,
    lastEventAt: "2026-09-25T11:06:00.042Z",
    finishedAt: "2026-09-25T11:06:00.042Z",
  };
  await render(finished);
  expect(mocks.stream).toHaveBeenLastCalledWith(null);
  expect(host.textContent).toContain(w.status.succeeded);
  expect(host.textContent).toContain("51.9 MB");
  expect(host.textContent).toContain("1m 10s");
  expect(host.querySelector("time")?.dateTime).toBe(finished.finishedAt);
  expect(host.textContent).not.toContain(w.phase.preparing);
  expect(mocks.update).toHaveBeenLastCalledWith(finished);
  expect(mocks.complete).toHaveBeenCalledOnce();
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(host.textContent).toContain("1m 10s");
  await render(finished);
  expect(mocks.complete).toHaveBeenCalledOnce();
});

it("keeps a newer parent snapshot while reconnecting an in-flight run", async () => {
  live.run = initial;
  live.reconnecting = true;
  const latest: BackupRun = {
    ...initial,
    status: "uploading",
    bytesTransferred: 4096,
    lastEventAt: "2026-09-25T11:05:00Z",
  };
  await render(latest);
  expect(host.textContent).toContain(w.phase.uploading);
  expect(host.textContent).toContain("4.0 KB");
  expect(host.textContent).toContain(w.reconnecting);
  expect(host.textContent).not.toContain(w.phase.preparing);
});

it("updates history from the live terminal snapshot and stops the elapsed clock", async () => {
  await render();
  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  live.run = {
    ...initial,
    status: "failed",
    errorMessage: "Storage disconnected",
    bytesTransferred: 0,
    finishedAt: "2026-09-25T11:04:54.604Z",
    lastEventAt: "2026-09-25T11:04:54.604Z",
  };
  await render();
  expect(host.textContent).toContain("Storage disconnected");
  expect(host.textContent).toContain("0 B");
  expect(host.textContent).toContain("5s");
  expect(mocks.update).toHaveBeenLastCalledWith(live.run);
  expect(mocks.complete).toHaveBeenCalledOnce();
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(host.textContent).toContain("5s");
});

it("keeps a dismissed run subscribed while stopping its hidden elapsed display", async () => {
  await render();
  await render(initial, false);
  expect(host.textContent).toBe("");
  expect(mocks.stream).toHaveBeenLastCalledWith(initial.id);
  expect(vi.getTimerCount()).toBe(0);
  live.run = { ...initial, status: "succeeded", finishedAt: "2026-09-25T11:04:54.604Z" };
  await render(initial, false);
  expect(mocks.update).toHaveBeenLastCalledWith(live.run);
  expect(mocks.complete).toHaveBeenCalledOnce();
  expect(host.textContent).toBe("");
});
