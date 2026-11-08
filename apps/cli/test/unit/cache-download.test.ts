import { afterEach, describe, expect, it } from "vitest";
import { createServer, type RequestListener, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadToFile } from "../../src/lib/cache";

let server: Server | undefined;
let directory: string | undefined;
afterEach(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function fixture(handler: RequestListener) {
  directory = await mkdtemp(join(tmpdir(), "openship-download-"));
  server = createServer(handler);
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, dest: join(directory, "asset") };
}

describe("streaming release downloads", () => {
  it("hashes a large closing response under file backpressure without crashing", async () => {
    const body = Buffer.alloc(8 * 1024 * 1024, 0x61);
    const { url, dest } = await fixture((_request, response) => {
      response.writeHead(200, { "content-length": body.length, connection: "close" });
      response.end(body);
    });
    const progress: number[] = [];
    const result = await downloadToFile(url, dest, received => progress.push(received));
    expect(result).toEqual({ size: body.length, sha256: createHash("sha256").update(body).digest("hex") });
    expect((await readFile(dest)).equals(body)).toBe(true);
    expect(progress.at(-1)).toBe(body.length);
  });
  it("follows release redirects and fails closed on a redirect loop", async () => {
    const { url, dest } = await fixture((request, response) => {
      if (request.url === "/asset") return response.end("verified bytes");
      response.writeHead(302, { location: request.url === "/loop" ? "/loop" : "/asset" });
      response.end();
    });
    expect((await downloadToFile(url, dest)).size).toBe(14);
    await expect(downloadToFile(url + "/loop", dest)).rejects.toThrow("Too many download redirects");
  });
  it("rejects an interrupted body and HTTP error", async () => {
    const { url, dest } = await fixture((request, response) => {
      if (request.url === "/missing") { response.writeHead(404); response.end("missing"); return; }
      response.writeHead(200, { "content-length": 100_000, connection: "close" });
      response.write("incomplete");
      setTimeout(() => response.destroy(), 10);
    });
    await expect(downloadToFile(url, dest)).rejects.toThrow();
    await expect(downloadToFile(url + "/missing", dest)).rejects.toThrow("HTTP 404");
  });
  it("propagates a destination write failure instead of reporting a downloaded artifact", async () => {
    const { url } = await fixture((_request, response) => response.end("bytes"));
    await expect(downloadToFile(url, directory!)).rejects.toThrow();
  });
});
