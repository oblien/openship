import { mock } from "bun:test";
import assert from "node:assert/strict";
import { createServer as httpServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

// Run in a fresh Bun process: its HTTP implementation must obey the boundary,
// and NODE_EXTRA_CA_CERTS must be loaded before the TLS runtime starts.
mock.module("node:dns/promises", () => ({
  lookup: async () => [{ address: "127.0.0.1", family: 4 }],
}));
const { resolveDestination } = await import("../../src/backup/registry");
await import("../../src/backup/destinations/s3");
let hits = 0;
const local = httpServer((_req, res) => {
  hits++;
  res.end();
});
local.listen(0, "127.0.0.1");
await once(local, "listening");
const port = (local.address() as { port: number }).port;
const row = {
  id: "probe",
  organizationId: "synthetic",
  name: "probe",
  kind: "s3_compatible" as const,
  endpoint: `http://storage.example.test:${port}`,
  region: "us-east-1",
  bucket: "synthetic",
  accessKeyIdEnc: "synthetic",
  secretAccessKeyEnc: "synthetic",
  publicNetworkOnly: true,
  pathPrefix: null,
  sshHost: null,
  sshPort: null,
  sshUser: null,
  sftpPasswordEnc: null,
  sftpPrivateKeyEnc: null,
  sftpKeyPassphraseEnc: null,
};
try {
  await assert.rejects(resolveDestination(row).head("manifest.json"), { code: "SSRF_BLOCKED" });
  assert.equal(hits, 0);
  await resolveDestination({
    ...row,
    endpoint: `http://127.0.0.1:${port}`,
    publicNetworkOnly: false,
  }).head("manifest.json");
  assert.equal(hits, 1);
} finally {
  local.closeAllConnections();
  await new Promise<void>((resolve) => local.close(() => resolve()));
}

// Separately exercise transport pinning and TLS. The address validator is
// replaced only here to let a local fixture stand in for a public server.
const guardPath = fileURLToPath(new URL("../../src/system/outbound-target.ts", import.meta.url));
const guard = await import(guardPath);
mock.module(guardPath, () => ({
  ...guard,
  resolvePinnedHost: async () => ({ ip: "127.0.0.1", family: 4 }),
}));
const { PublicHttpHandler } = await import("../../src/system/public-http-handler");
const handler = new PublicHttpHandler();
const request = {
  protocol: "https:",
  hostname: "storage.example.test",
  port: Number(process.argv[2]),
  method: "GET",
  path: "/a%2Fb",
  query: { x: ["1", "2"] },
  headers: { host: "storage.example.test", authorization: "synthetic-signature" },
  clone() {
    return { ...this, headers: { ...this.headers } };
  },
};
try {
  const { response } = await handler.handle(request);
  assert.equal(response.statusCode, 200);
  const chunks = [];
  for await (const chunk of response.body) chunks.push(Buffer.from(chunk));
  assert.equal(Buffer.concat(chunks).toString(), "pinned");
  await assert.rejects(
    handler.handle({
      ...request,
      hostname: "wrong.example.test",
      headers: { host: "wrong.example.test" },
    }),
  );
  console.log(
    "Bun backup transport: private DNS blocked, self-hosted LAN allowed, pinned TLS and signed request preserved, wrong certificate rejected",
  );
} finally {
  handler.destroy();
}
