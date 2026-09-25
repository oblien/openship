import { EventEmitter } from "node:events";
import { Duplex, PassThrough, Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BareBackupExecutor } from "../backup/executors/bare";
import type { BareRuntime } from "../runtime/bare";
import type { ServiceHandle } from "../backup/types";

const connectSshClient = vi.hoisted(() => vi.fn());
vi.mock("./ssh-client", () => ({ connectSshClient }));
import { SshExecutor } from "./ssh-executor";

class Channel extends Duplex {
  command = "";
  stderr = new PassThrough();
  chunks: Buffer[] = [];
  close = vi.fn(() => {
    this.emit("close", null);
  });
  _read() {}
  _write(chunk: Buffer, _encoding: string, done: () => void) {
    this.chunks.push(Buffer.from(chunk));
    done();
  }
}

function connection() {
  const channels: Channel[] = [];
  const client = Object.assign(new EventEmitter(), {
    exec: vi.fn((cmd: string, callback: (err: null, stream: Channel) => void) => {
      const channel = new Channel();
      channel.command = cmd;
      channels.push(channel);
      callback(null, channel);
    }),
    end: vi.fn(),
    destroy: vi.fn(),
  });
  connectSshClient.mockResolvedValue(client);
  return {
    client,
    channels,
    executor: new SshExecutor({ host: "test", username: "test", privateKey: "test" }),
  };
}

beforeEach(() => connectSshClient.mockReset());

describe("restore stdin owns only its SSH channel", () => {
  it("cancels a loader after all input was consumed without closing the pooled connection", async () => {
    const { executor, client, channels } = connection();
    const body = Readable.from([Buffer.from([0, 255, 13, 10])]);
    const controller = new AbortController();
    const pending = executor.runWithAbortSignal(controller.signal, () =>
      executor.execWithInput("loader", body),
    );
    const failed = expect(pending).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(body.readableEnded).toBe(true));
    expect(Buffer.concat(channels[0]!.chunks)).toEqual(Buffer.from([0, 255, 13, 10]));
    controller.abort();
    await failed;
    expect(channels[0]!.close).toHaveBeenCalledOnce();
    expect(client.end).not.toHaveBeenCalled();
    expect(client.destroy).not.toHaveBeenCalled();
  });

  it("does not cancel another command sharing the same connection", async () => {
    const { executor, channels } = connection();
    const controller = new AbortController();
    const first = executor.runWithAbortSignal(controller.signal, () =>
      executor.execWithInput("first", Readable.from(["a"])),
    );
    const failed = expect(first).rejects.toThrow("cancelled");
    const second = executor.execWithInput("second", Readable.from(["b"]));
    await vi.waitFor(() => expect(channels).toHaveLength(2));
    controller.abort();
    await failed;
    const other = channels.find((channel) => channel.command === "second")!;
    expect(other.close).not.toHaveBeenCalled();
    other.stderr.write("loader diagnostic");
    other.emit("close", 7);
    expect(await second).toMatchObject({ code: 7, stderr: "loader diagnostic" });
  });

  it("closes a late channel allocated after cancellation", async () => {
    const { executor, client } = connection();
    let allocated!: (err: null, stream: Channel) => void;
    client.exec.mockImplementation((_cmd, callback) => {
      allocated = callback;
    });
    const controller = new AbortController();
    const pending = executor.runWithAbortSignal(controller.signal, () =>
      executor.execWithInput("late", Readable.from(["dump"])),
    );
    const failed = expect(pending).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(allocated).toBeDefined());
    controller.abort();
    await failed;
    const channel = new Channel();
    allocated(null, channel);
    expect(channel.close).toHaveBeenCalledOnce();
    expect(channel.chunks).toHaveLength(0);
  });

  it("propagates the backup restore's deadline to the channel, even after EOF", async () => {
    const { executor, channels } = connection();
    const backup = new BareBackupExecutor({ commandExecutor: executor } as unknown as BareRuntime);
    await expect(
      backup.pipeIntoCommand(
        { name: "mail" } as ServiceHandle,
        ["loader"],
        Readable.from(["dump"]),
        { timeoutMs: 100 },
      ),
    ).rejects.toThrow("ceiling");
    expect(channels[0]!.close).toHaveBeenCalledOnce();
  });
});
