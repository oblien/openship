import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { DockerRuntime } from "./docker";

async function runtimeWith(stream: PassThrough): Promise<DockerRuntime> {
  const runtime = await DockerRuntime.create({
    dockerSocketPath: "/tmp/openship-runtime-logs-test.sock",
  });
  (runtime as unknown as { _docker: unknown })._docker = {
    getContainer: () => ({ logs: vi.fn(async () => stream) }),
  };
  return runtime;
}

describe("DockerRuntime.streamRuntimeLogs", () => {
  it("reports a natural stream end once", async () => {
    const stream = new PassThrough();
    const onEnd = vi.fn();
    await (await runtimeWith(stream)).streamRuntimeLogs("container-1", vi.fn(), { onEnd });

    stream.end();
    stream.emit("close");

    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it("does not report an explicit cleanup as a natural end", async () => {
    const stream = new PassThrough();
    const onEnd = vi.fn();
    const cleanup = await (await runtimeWith(stream)).streamRuntimeLogs(
      "container-1",
      vi.fn(),
      { onEnd },
    );

    cleanup();
    stream.emit("end");
    stream.emit("close");

    expect(onEnd).not.toHaveBeenCalled();
  });

  it("handles a source error as a terminal stream event", async () => {
    const stream = new PassThrough();
    const onEnd = vi.fn();
    await (await runtimeWith(stream)).streamRuntimeLogs("container-1", vi.fn(), { onEnd });

    stream.emit("error", new Error("socket closed"));
    stream.emit("close");

    expect(onEnd).toHaveBeenCalledTimes(1);
  });
});
