import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type AddressInfo } from "node:net";

const h = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: h.lookup }));
import { resolveLatestVersion } from "@repo/platform/engine/lib/release-resolver";

let connections = 0;
let port: number;
const server = createServer(socket => { connections++; socket.destroy(); });
beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  h.lookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
});
afterAll(() => new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())));

describe("release feed transport boundary", () => {
  it.each(["release.example.test", "127.0.0.1", "localhost."])("never connects to a private HTTPS feed: %s", async host => {
    expect(await resolveLatestVersion({ mode: "url", distUrl: "https://example.test/app.tar.gz", versionUrl: `https://${host}:${port}/version` })).toBeNull();
    expect(connections).toBe(0);
  });
});
