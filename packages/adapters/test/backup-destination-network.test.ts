import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackupDestinationRow } from "../src/backup/types";
import { resolveDestination } from "../src/backup/registry";
import "../src/backup/destinations/s3";

const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns/promises", () => dns);

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function endpoint() {
  const hit = vi.fn();
  const server = createServer((_req, res) => {
    hit();
    res.writeHead(200, { "Content-Length": "0" });
    res.end();
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { hit, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

function row(endpoint: string, publicNetworkOnly: boolean): BackupDestinationRow {
  return {
    id: "backup",
    organizationId: "tenant",
    name: "backup",
    kind: "s3_compatible",
    endpoint,
    region: "us-east-1",
    bucket: "test",
    pathPrefix: null,
    sshHost: null,
    sshPort: null,
    sshUser: null,
    accessKeyIdEnc: "test-key",
    secretAccessKeyEnc: "test-secret",
    sftpPasswordEnc: null,
    sftpPrivateKeyEnc: null,
    sftpKeyPassphraseEnc: null,
    publicNetworkOnly,
  };
}

describe("backup destination network boundary", () => {
  it("blocks a retained Cloud destination before any request reaches a private service", async () => {
    const target = await endpoint();
    await expect(
      Promise.resolve().then(() => resolveDestination(row(target.url, true)).head("manifest.json")),
    ).rejects.toMatchObject({ code: "SSRF_BLOCKED" });
    expect(target.hit).not.toHaveBeenCalled();
  });

  it("keeps private object storage working for self-hosted operators", async () => {
    const target = await endpoint();
    await resolveDestination(row(target.url, false)).head("manifest.json");
    expect(target.hit).toHaveBeenCalledOnce();
  });

  it("rejects a hostname whose DNS changed to loopback before the actual S3 connection", async () => {
    const target = await endpoint();
    dns.lookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    const url = target.url.replace("127.0.0.1", "storage.example.test");
    await expect(resolveDestination(row(url, true)).head("manifest.json")).rejects.toMatchObject({
      code: "SSRF_BLOCKED",
    });
    expect(target.hit).not.toHaveBeenCalled();
  });
});
