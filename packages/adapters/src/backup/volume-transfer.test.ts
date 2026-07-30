import { describe, expect, test } from "vitest";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { resolvePlan, transferVolume, type TransferEndpoint } from "./volume-transfer";
import type { BackupExecutor, ServiceHandle } from "./types";

const handle: ServiceHandle = {
  id: "svc",
  projectId: "proj",
  name: "db",
  image: null,
  env: {},
  volumes: [],
  containerId: null,
  projectSlug: "slug",
  namespaceVolumes: false,
};

/** Distinct src/dst executors → cross-daemon → the stream path (not direct). */
function streamExecs(chunks: Buffer[], sink: Buffer[]) {
  const src = {
    runtimeName: "docker",
    async streamPath() {
      const stdout = Readable.from(chunks);
      const awaitExit = new Promise<{ code: number; stderr: string }>((resolve) =>
        stdout.once("end", () => resolve({ code: 0, stderr: "" })),
      );
      return { stdout, awaitExit };
    },
  } as unknown as BackupExecutor;
  const dst = {
    runtimeName: "docker",
    async receiveStream(_s: ServiceHandle, _id: string, body: Readable) {
      let bytesWritten = 0;
      await pipeline(
        body,
        new Writable({
          write(chunk: Buffer, _enc, cb) {
            bytesWritten += chunk.length;
            sink.push(Buffer.from(chunk));
            cb();
          },
        }),
      );
      return { bytesWritten };
    },
  } as unknown as BackupExecutor;
  return { src, dst };
}

describe("transferVolume onProgress (stream mode)", () => {
  test("reports a monotonic byte count ending at the total moved", async () => {
    const chunks = [Buffer.from("aaaa"), Buffer.from("bb"), Buffer.from("cccc")];
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const sink: Buffer[] = [];
    const { src, dst } = streamExecs(chunks, sink);

    const progress: number[] = [];
    const from: TransferEndpoint = { exec: src, handle, sourceId: "vol" };
    const to: TransferEndpoint = { exec: dst, handle, sourceId: "vol" };
    const res = await transferVolume(from, to, {
      mode: "stream",
      onProgress: (n) => progress.push(n),
    });

    expect(res.strategy).toBe("stream");
    expect(res.bytesMoved).toBe(total);
    expect(Buffer.concat(sink).length).toBe(total);
    expect(progress[progress.length - 1]).toBe(total);
    expect([...progress]).toEqual([...progress].sort((a, b) => a - b));
  });
});

describe("resolvePlan still records adjustments", () => {
  test("rsync falls back to stream with a note (reserved)", () => {
    const ep = { exec: {} as BackupExecutor, handle, sourceId: "v" };
    const plan = resolvePlan(ep, { ...ep, exec: {} as BackupExecutor }, { mode: "rsync" });
    expect(plan.mode).toBe("stream");
    expect(plan.note).toMatch(/rsync/i);
  });
});
