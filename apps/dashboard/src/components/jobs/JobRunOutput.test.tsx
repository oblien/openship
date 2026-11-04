// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { JobRun } from "@repo/contracts";
import { baseDictionary } from "@/i18n";
import { JobRunOutput } from "./JobRunOutput";

const h = vi.hoisted(() => ({
  snapshot: null as null | ((run: JobRun) => void),
  event: null as null | ((event: object) => void),
  path: null as string | null,
  error: null as Error | null,
  reconnect: vi.fn(),
}));
vi.mock("@/components/i18n-provider", () => ({ useI18n: () => ({ t: baseDictionary }) }));
vi.mock("@/components/import-project/LogSnapshotTerminal", () => ({
  LogSnapshotTerminal: ({ logs }: { logs: string }) => <pre data-logs>{logs}</pre>,
}));
vi.mock("@/hooks/useRunEvents", () => ({
  useRunEvents: (
    path: string | null,
    snapshot: typeof h.snapshot,
    options: { onEvent: typeof h.event },
  ) => {
    h.path = path;
    h.snapshot = snapshot;
    h.event = options.onEvent;
    return { error: h.error, reconnect: h.reconnect };
  },
}));
let root: Root, container: HTMLDivElement;
let run: JobRun;
const render = () =>
  root.render(<JobRunOutput run={run} path="system/servers/host/security/runs/run-1/stream" />);
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.error = null;
  h.reconnect.mockReset();
  run = {
    id: "run-1",
    jobId: "security:patch:host",
    serverId: "host",
    kind: "custom",
    trigger: "manual",
    status: "running",
    attempt: 1,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    durationMs: null,
    error: null,
    createdAt: new Date().toISOString(),
    output: "saved\n",
    summary: {
      logSeq: 1,
      steps: [
        { id: "prepare", label: "Check server", status: "completed" },
        { id: "apply", label: "Install packages", status: "running" },
        { id: "verify", label: "Verify packages", status: "pending" },
      ],
    },
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
it("merges streamed and saved logs exactly once across replay and shows persisted steps", async () => {
  await act(async () => render());
  expect(container.textContent).toContain("Verify packages");
  await act(async () => h.event!({ type: "log", seq: 2, line: "installing" }));
  expect(container.querySelector("[data-logs]")?.textContent).toBe("saved\ninstalling\n");
  // Reconnecting can replay a line that arrived just before the DB snapshot.
  await act(async () => {
    h.snapshot!({ ...run, output: "saved\ninstalling\n", summary: { ...run.summary, logSeq: 2 } });
    h.event!({ type: "log", seq: 2, line: "installing" });
    h.event!({ type: "log", seq: 3, line: "verified" });
  });
  expect(container.querySelector("[data-logs]")?.textContent).toBe("saved\ninstalling\nverified\n");
});
it("keeps the real outcome and saved logs when a live connection fails", async () => {
  h.error = new Error("Disconnected");
  await act(async () => render());
  expect(container.textContent).toContain("Disconnected");
  expect(container.textContent).toContain("saved");
  expect(container.textContent).not.toContain(baseDictionary.actions.status.failure);
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === baseDictionary.actions.retry)!
      .click(),
  );
  expect(h.reconnect).toHaveBeenCalledTimes(1);
});
it("replays completed runs without opening a connection and rejects a foreign snapshot", async () => {
  run = { ...run, status: "success", output: "verified\n" };
  await act(async () => render());
  expect(h.path).toBeNull();
  expect(container.querySelector("[data-logs]")?.textContent).toBe("verified\n");
  expect(() => h.snapshot!({ ...run, id: "another-run" })).toThrow(/another run/);
});
it("shows interrupted steps as failed or skipped instead of continuing to spin", async () => {
  run = { ...run, status: "failed", error: "Execution interrupted" };
  await act(async () => render());
  expect(container.textContent).toContain(baseDictionary.actions.status.skipped);
  expect(container.textContent).not.toContain(baseDictionary.actions.status.queued);
  expect(container.textContent).not.toContain(baseDictionary.actions.status.running);
});
