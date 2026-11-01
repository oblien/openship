import { expect, it, vi } from "vitest";
import { NohupSupervisor } from "./supervisor/nohup";
import { SystemdSupervisor } from "./supervisor/systemd";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

for (const Supervisor of [NohupSupervisor, SystemdSupervisor]) {
  it(`${Supervisor.name} reports a failing log reader as retryable`, async () => {
    const executor = { streamExec: async () => ({ code: 1, output: "" }), exists: async () => true };
    const ended = deferred<Error | undefined>();
    await new Supervisor(executor as never, "/tmp/test-logs").streamLogs("deployment", vi.fn(), { onEnd: ended.resolve });
    expect((await ended.promise)?.message).toBe("Log reader exited with code 1");
  });
  it(`${Supervisor.name} distinguishes a transport failure from intentional cleanup`, async () => {
    const gate = deferred<void>();
    const executor = { streamExec: () => gate.promise, exists: async () => true, exec: vi.fn(async () => ({})) };
    const supervisor = new Supervisor(executor as never, "/tmp/test-logs");
    const onEnd = vi.fn();
    await supervisor.streamLogs("deployment", vi.fn(), { onEnd });
    const error = new Error("SSH disconnected");
    gate.reject(error);
    await Promise.resolve();
    expect(onEnd).toHaveBeenCalledWith(error);

    const second = deferred<void>();
    executor.streamExec = () => second.promise;
    onEnd.mockClear();
    const stop = await supervisor.streamLogs("deployment", vi.fn(), { onEnd });
    stop();
    second.resolve(undefined);
    await Promise.resolve();
    expect(onEnd).not.toHaveBeenCalled();
  });
}
