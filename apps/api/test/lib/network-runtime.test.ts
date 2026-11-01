import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TLSSocket } from "node:tls";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const apiDir = fileURLToPath(new URL("../../", import.meta.url));
const fixture = fileURLToPath(new URL("../fixtures/network-runtime.ts", import.meta.url));
let directory: string;
let server: https.Server | undefined;
let port: number;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "openship-network-runtime-"));
  await writeFile(
    join(directory, "ca.cnf"),
    `[req]
distinguished_name=dn
x509_extensions=ca
prompt=no
[dn]
CN=Openship runtime test CA
[ca]
basicConstraints=critical,CA:TRUE
keyUsage=critical,keyCertSign,cRLSign
`,
  );
  await writeFile(
    join(directory, "server.cnf"),
    `[req]
distinguished_name=dn
prompt=no
[dn]
CN=localhost
[server]
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:localhost
`,
  );
  const commands = [
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "2",
      "-config",
      "ca.cnf",
      "-keyout",
      "ca.key",
      "-out",
      "ca.pem",
    ],
    [
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-config",
      "server.cnf",
      "-keyout",
      "server.key",
      "-out",
      "server.csr",
    ],
    [
      "x509",
      "-req",
      "-days",
      "2",
      "-in",
      "server.csr",
      "-CA",
      "ca.pem",
      "-CAkey",
      "ca.key",
      "-CAcreateserial",
      "-extfile",
      "server.cnf",
      "-extensions",
      "server",
      "-out",
      "server.pem",
    ],
  ];
  for (const args of commands) await exec("openssl", args, { cwd: directory });

  server = https.createServer(
    {
      key: await readFile(join(directory, "server.key")),
      cert: await readFile(join(directory, "server.pem")),
    },
    (req, res) => {
      res.writeHead(401, { "www-authenticate": 'Basic realm="runtime-test"' });
      res.end(
        JSON.stringify({ host: req.headers.host, sni: (req.socket as TLSSocket).servername }),
      );
    },
  );
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});

it("pins the API installer and its patched Node runtime", async () => {
  const repoDir = fileURLToPath(new URL("../../../../", import.meta.url));
  const version = (await readFile(join(repoDir, ".bun-version"), "utf8")).trim();
  const dockerfile = await readFile(join(apiDir, "Dockerfile"), "utf8");
  expect(dockerfile).toContain(`FROM oven/bun:${version}@sha256:`);
  const nodeImage = dockerfile.match(
    /^ARG NODE_IMAGE=(node:22\.23\.4-bookworm-slim@sha256:[a-f0-9]{64})$/m,
  )?.[1];
  expect(nodeImage).toBeDefined();
  expect(dockerfile).toContain("FROM ${NODE_IMAGE} AS runner");
  expect(dockerfile).toContain("FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS node-build");
  const manifest = JSON.parse(await readFile(join(repoDir, "package.json"), "utf8"));
  expect(manifest.packageManager).toBe(`bun@${version}`);
});

// Vitest runs on Node even when invoked with `bun run test`. Separate processes
// exercise the production Node transport and the Bun development path.
describe.each(["node", "bun"])("API network transport under %s", (runtime) => {
  async function probe(mode: "tls" | "untrusted-ca" | "websocket") {
    const env = {
      ...process.env,
      NODE_ENV: "test",
      OPENSHIP_TARGET: "local",
      INTERNAL_TOKEN: "test-network-runtime-internal-token",
      NODE_EXTRA_CA_CERTS: mode === "untrusted-ca" ? undefined : join(directory, "ca.pem"),
      NODE_TLS_REJECT_UNAUTHORIZED: undefined,
    };
    const args = runtime === "node" ? ["--import", "tsx", fixture] : [fixture];
    const result = await exec(runtime, [...args, mode, String(port)], {
      cwd: apiDir,
      env,
      timeout: 10_000,
    });
    expect(result.stdout).toContain(`network-runtime: ${mode} passed`);
  }

  it("verifies the hostname when HTTPS connects to a pinned IP on a custom port", () =>
    probe("tls"));
  it("rejects a registry certificate whose CA is not trusted", () => probe("untrusted-ca"));
  it("completes async authenticated upgrades and stays healthy after auth rejection", () =>
    probe("websocket"));
});
