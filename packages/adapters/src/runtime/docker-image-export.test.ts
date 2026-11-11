import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { DockerRuntime } from "./docker";
import type { CommandExecutor } from "../types";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function cloudImageSource(write: (response: ServerResponse) => Promise<void>) {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url!);
    response.writeHead(200, { "content-type": "application/x-tar" });
    void write(response).catch((error) => response.destroy(error));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const rawExec = vi.fn(async () => {
    throw new Error("Command streams cannot carry this image");
  });
  const runtime = await DockerRuntime.create({
    transport: "cloud",
    executor: { rawExec } as unknown as CommandExecutor,
    cloudConnection: async () => connect((server.address() as AddressInfo).port, "127.0.0.1"),
  });
  cleanup.push(() => runtime.dispose());
  return { runtime, rawExec, requests };
}

describe("Cloud image export", () => {
  it("preserves binary image bytes when the receiver applies backpressure", async () => {
    const chunk = Buffer.from(Array.from({ length: 64 * 1024 }, (_, i) => i % 256));
    const count = 64;
    const expected = createHash("sha256");
    for (let i = 0; i < count; i++) expected.update(chunk);
    const source = await cloudImageSource(async (response) => {
      for (let i = 0; i < count; i++) {
        if (!response.write(chunk)) await once(response, "drain");
      }
      response.end();
    });
    const image = await source.runtime.saveImage("sha256:abc123");
    const actual = createHash("sha256");
    let bytes = 0;
    for await (const part of image.stdout) {
      actual.update(part);
      bytes += part.length;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(bytes).toBe(count * chunk.length);
    expect(actual.digest("hex")).toBe(expected.digest("hex"));
    await expect(image.awaitExit).resolves.toEqual({ code: 0, stderr: "" });
    expect(source.requests).toEqual(["/images/sha256:abc123/get"]);
    expect(source.rawExec).not.toHaveBeenCalled();
  });

  it("rejects a truncated Docker response instead of reporting a successful export", async () => {
    const source = await cloudImageSource(async (response) => {
      response.write(Buffer.alloc(64 * 1024, 0x80));
      await new Promise((resolve) => setTimeout(resolve, 20));
      response.destroy();
    });
    const image = await source.runtime.saveImage("sha256:abc123");
    const results = await Promise.allSettled([
      image.awaitExit,
      (async () => {
        for await (const _part of image.stdout) {
          /* drain */
        }
      })(),
    ]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
  });
});
