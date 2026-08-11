import { describe, expect, test } from "vitest";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { transferImage } from "./image-transfer";
import type { DockerRuntime } from "./docker";

/** A fake source: `saveImage` emits the given chunks, then exits with `code`. */
function fakeSource(chunks: Buffer[], code = 0, stderr = ""): DockerRuntime {
  return {
    async saveImage() {
      const stdout = Readable.from(chunks);
      // awaitExit only resolves once the stream is fully consumed, mirroring a
      // real `docker save` whose process exits after its stdout drains.
      const awaitExit = new Promise<{ code: number; stderr: string }>((resolve) => {
        stdout.once("end", () => resolve({ code, stderr }));
      });
      return { stdout, awaitExit };
    },
  } as unknown as DockerRuntime;
}

/** A fake target: `loadImage` drains the body into `sink` and reports
 *  `loadedRef` (as `docker load` would); `tagImage` records the re-tag. */
function fakeTarget(
  sink: Buffer[],
  tags?: Array<[string, string]>,
  loadedRef?: string,
): DockerRuntime {
  return {
    async loadImage(body: Readable) {
      await pipeline(
        body,
        new Writable({
          write(chunk: Buffer, _enc, cb) {
            sink.push(Buffer.from(chunk));
            cb();
          },
        }),
      );
      return loadedRef;
    },
    async tagImage(source: string, target: string) {
      tags?.push([source, target]);
    },
  } as unknown as DockerRuntime;
}

const IMG = { id: "sha256:abcdef0123456789", tag: "openship/app:sess" };

describe("transferImage", () => {
  test("streams save → load and counts bytes + progress", async () => {
    const chunks = [Buffer.from("layer-a"), Buffer.from("layer-bb"), Buffer.from("c")];
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const sink: Buffer[] = [];
    const tags: Array<[string, string]> = [];
    const progress: number[] = [];

    const res = await transferImage(fakeSource(chunks), fakeTarget(sink, tags), IMG, {
      onProgress: (n) => progress.push(n),
    });

    expect(res.bytesMoved).toBe(total);
    // The target received exactly the source bytes, in order.
    expect(Buffer.concat(sink).toString()).toBe("layer-alayer-bbc");
    // Progress is monotonic and ends at the total.
    expect(progress[progress.length - 1]).toBe(total);
    expect([...progress]).toEqual([...progress].sort((a, b) => a - b));
    // The tag is re-applied on the target (loaded untagged when saved by id).
    expect(tags).toEqual([[IMG.id, IMG.tag]]);
  });

  test("retags from the ref docker load actually restored (not the source id)", async () => {
    // `image.id` is a RepoDigest that does NOT resolve on the target; the load
    // restores under the config id — retag must use THAT, or it'd fail on box.
    const sink: Buffer[] = [];
    const tags: Array<[string, string]> = [];
    const loadedConfigId = "sha256:deadbeefcafe";

    await transferImage(fakeSource([Buffer.from("x")]), fakeTarget(sink, tags, loadedConfigId), IMG);

    expect(tags).toEqual([[loadedConfigId, IMG.tag]]);
  });

  test("throws when docker save exits non-zero (never a silent truncation)", async () => {
    const sink: Buffer[] = [];
    await expect(
      transferImage(fakeSource([Buffer.from("partial")], 1, "no such image"), fakeTarget(sink), {
        id: "sha256:ghost",
        tag: "ghost:1",
      }),
    ).rejects.toThrow(/Image transfer failed \(ghost:1\).*no such image/s);
  });

  test("propagates a target load failure", async () => {
    const failingTarget = {
      async loadImage() {
        throw new Error("docker load exited 1: unexpected EOF");
      },
    } as unknown as DockerRuntime;
    await expect(transferImage(fakeSource([Buffer.from("x")]), failingTarget, IMG)).rejects.toThrow(
      /unexpected EOF/,
    );
  });
});
