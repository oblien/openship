import { afterEach, describe, expect, it, vi } from "vitest";
import { DockerRuntime } from "./docker";
import type Dockerode from "dockerode";
import { removeDockerContainer } from "./docker-container-removal";

const OLD = "a".repeat(64);
const NEW = "b".repeat(64);
const missing = () => Object.assign(new Error("No such container"), { statusCode: 404 });
const removing = () =>
  Object.assign(new Error(`removal of container ${OLD} is already in progress`), {
    statusCode: 409,
  });

async function fixture() {
  let removed = false;
  const inspection = { Id: OLD, State: { Status: "exited", RemovalInProgress: false } };
  const inspect = vi.fn(async () => {
    if (removed) throw missing();
    return inspection;
  });
  const stop = vi.fn(async () => undefined);
  const remove = vi.fn(async (): Promise<void> => {
    throw removing();
  });
  const getContainer = vi.fn((id: string) => ({ id, inspect, stop, remove }));
  const docker = { getContainer } as unknown as Dockerode;
  const runtime = await DockerRuntime.create({
    dockerSocketPath: "/tmp/openship-test-absent.sock",
  });
  (runtime as unknown as { _docker: Dockerode })._docker = docker;
  return {
    runtime,
    docker,
    getContainer,
    inspect,
    stop,
    remove,
    inspection,
    gone: () => {
      removed = true;
    },
  };
}

afterEach(() => vi.useRealTimers());

describe("Docker container removal convergence", () => {
  it("does not report an in-progress removal complete until that exact container disappears", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    let finished = false;
    const operation = f.runtime.destroy(OLD).then(() => {
      finished = true;
    });
    const expected = expect(operation).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(500);
    expect(finished).toBe(false);
    expect(f.remove).toHaveBeenCalledOnce();
    f.gone();
    await vi.advanceTimersByTimeAsync(500);
    await expected;
    expect(finished).toBe(true);
    expect(f.remove).toHaveBeenCalledOnce();
  });

  it("pins a name once and leaves a same-named successor untouched", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    let successor = false;
    const successorStop = vi.fn();
    const successorRemove = vi.fn();
    f.getContainer.mockImplementation((id: string) =>
      id === "service" && successor
        ? ({
            id: NEW,
            inspect: async () => ({ Id: NEW, State: { Status: "running" } }),
            stop: successorStop,
            remove: successorRemove,
          } as any)
        : { id, inspect: f.inspect, stop: f.stop, remove: f.remove },
    );
    const operation = f.runtime.destroy("service");
    const expected = expect(operation).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(500);
    successor = true;
    f.gone();
    await vi.advanceTimersByTimeAsync(500);
    await expected;
    expect(f.getContainer.mock.calls.filter(([id]) => id === "service")).toHaveLength(1);
    expect(successorStop).not.toHaveBeenCalled();
    expect(successorRemove).not.toHaveBeenCalled();
  });

  it("does not retry an unrelated 409", async () => {
    const f = await fixture();
    const error = Object.assign(new Error("container is in use by another process"), {
      statusCode: 409,
    });
    f.remove.mockRejectedValue(error);
    await expect(f.runtime.destroy(OLD)).rejects.toBe(error);
    expect(f.remove).toHaveBeenCalledOnce();
  });

  it("waits for an already-removing container without issuing another stop or remove", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    f.inspection.State.Status = "removing";
    const operation = f.runtime.destroy(OLD);
    await vi.advanceTimersByTimeAsync(500);
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.remove).not.toHaveBeenCalled();
    f.gone();
    await vi.advanceTimersByTimeAsync(500);
    await operation;
  });

  it.each(["pending remove", "pending inspect", "removing forever"])(
    "bounds %s even when a transport ignores cancellation",
    async (condition) => {
      vi.useFakeTimers();
      const f = await fixture();
      if (condition === "pending remove") f.remove.mockImplementation(() => new Promise(() => {}));
      if (condition === "pending inspect")
        f.inspect.mockImplementation(() => new Promise(() => {}));
      const operation = removeDockerContainer(f.docker, OLD, { timeoutMs: 1_000 });
      const expected = expect(operation).rejects.toThrow("did not finish within 1000ms");
      await vi.advanceTimersByTimeAsync(1_000);
      await expected;
      expect(f.remove.mock.calls.length).toBeLessThanOrEqual(1);
    },
  );

  it("cancels an in-progress removal without sending another mutation", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const controller = new AbortController();
    const operation = removeDockerContainer(f.docker, OLD, { signal: controller.signal });
    const expected = expect(operation).rejects.toThrow("cancelled by owner");
    await vi.advanceTimersByTimeAsync(500);
    controller.abort(new Error("cancelled by owner"));
    await expected;
    expect(f.remove).toHaveBeenCalledOnce();
  });

  it("honors a configured stop grace longer than the default removal deadline", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    Object.assign(f.inspection, { Config: { StopTimeout: 300 } });
    f.stop.mockImplementation(
      () => new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 300_000)),
    );
    f.remove.mockImplementation(async () => {
      f.gone();
    });
    const operation = removeDockerContainer(f.docker, OLD);
    const expected = expect(operation).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(300_000);
    await expected;
    expect(f.remove).toHaveBeenCalledOnce();
  });

  it("rechecks access for the pinned identity before either mutation", async () => {
    const f = await fixture();
    const denied = new Error("another project owns this container");
    const assertAccess = vi.fn(async () => {
      throw denied;
    });
    await expect(removeDockerContainer(f.docker, "service", { assertAccess })).rejects.toBe(denied);
    expect(assertAccess).toHaveBeenCalledExactlyOnceWith(OLD);
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.remove).not.toHaveBeenCalled();
  });

  it("does not guess after malformed inspection or an unavailable daemon", async () => {
    const f = await fixture();
    f.inspection.Id = "not-an-exact-id";
    await expect(f.runtime.destroy("service")).rejects.toThrow("exact container identity");
    const unavailable = Object.assign(new Error("daemon unavailable"), { statusCode: 503 });
    f.inspect.mockRejectedValue(unavailable);
    await expect(f.runtime.destroy("service")).rejects.toBe(unavailable);
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.remove).not.toHaveBeenCalled();
  });
});
