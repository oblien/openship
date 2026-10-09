import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  tick: vi.fn(),
  unsettled: vi.fn(),
}));
vi.mock("@repo/db", () => ({
  repos: {
    actions: {
      unsettledRunCount: state.unsettled,
      pruneDeliveries: async () => {},
      pruneRuns: async () => {},
    },
  },
}));
vi.mock("../../native/execution-policy", () => ({ nativeJobsEnabled: () => true }));
vi.mock("../../lib/background-work", () => ({
  trackBackgroundWork: (work: Promise<void>) => work,
}));
vi.mock("./execution", () => ({ actionController: { tick: state.tick } }));
vi.mock("./cloud-runner", () => ({ ensureConfiguredActionPools: async () => {} }));
vi.mock("./triggers", () => ({
  dispatchActionSchedules: async () => {},
  actionWebhookInbox: { tick: async () => {} },
}));
vi.mock("./storage", () => ({ actionStorageProtocol: () => ({ sweep: async () => {} }) }));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("Actions controller shutdown", () => {
  async function running() {
    let finish!: () => void;
    state.tick.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const lifecycle = await import("./lifecycle");
    lifecycle.startActionController();
    await vi.advanceTimersByTimeAsync(0);
    await vi.dynamicImportSettled();
    expect(state.tick).toHaveBeenCalledOnce();
    return { lifecycle, finish };
  }

  it("bounds process shutdown, stops admission, and leaves the remote execution for recovery", async () => {
    const { lifecycle, finish } = await running();
    let stopped = false;
    const stopping = lifecycle.stopActionController(500).then(() => {
      stopped = true;
    });
    expect(state.tick.mock.calls[0]![0].aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(499);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await stopping;
    finish();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(state.tick).toHaveBeenCalledOnce();
  });

  it("waits for full quiescence during an instance move", async () => {
    const { lifecycle, finish } = await running();
    let stopped = false;
    const stopping = lifecycle.stopActionController().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(stopped).toBe(false);
    finish();
    await stopping;
    expect(stopped).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refuses to move active executions or pending cleanup", async () => {
    const { assertActionsTransferReady } = await import("./lifecycle");
    state.unsettled.mockResolvedValue(1);
    await expect(assertActionsTransferReady()).rejects.toMatchObject({
      code: "ACTIONS_INSTANCE_MOVE_BUSY",
    });
    state.unsettled.mockResolvedValue(0);
    await expect(assertActionsTransferReady()).resolves.toBeUndefined();
  });
});
