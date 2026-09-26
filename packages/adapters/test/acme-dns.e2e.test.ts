import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, createConnection } from "node:net";
import { X509Certificate, createPrivateKey } from "node:crypto";
import { createAcmeDnsProvider, type AcmeDnsOptions } from "../src/infra/acme-dns";
import { validateCertFor } from "../src/system/proxy/cert-material";

const execute = promisify(execFile);
const version = "v2.10.1";
const servers: ChildProcess[] = [];
let directory: string;
let managementUrl: string;
let options: AcmeDnsOptions;
let output = "";

async function port(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing listener address");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}
async function ready(port: number) {
  for (let i = 0; i < 100; i++) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.on("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.on("error", () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (connected) return;
    if (servers.some((server) => server.exitCode !== null)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`ACME test server did not start: ${output}`);
}
function start(binary: string, args: string[]) {
  const server = spawn(binary, args, {
    env: {
      ...process.env,
      PEBBLE_VA_NOSLEEP: "1",
      PEBBLE_WFE_NONCEREJECT: "0",
      PEBBLE_AUTHZREUSE: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.on("error", (error) => {
    output += error.message;
  });
  server.stdout?.on("data", (chunk) => {
    output = (output + String(chunk)).slice(-8000);
  });
  server.stderr?.on("data", (chunk) => {
    output = (output + String(chunk)).slice(-8000);
  });
  servers.push(server);
}
async function publish(record: { name: string; value: string }) {
  const result = await fetch(`${managementUrl}/set-txt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ host: `${record.name}.`, value: record.value }),
    signal: AbortSignal.timeout(5000),
  });
  expect(result.ok).toBe(true);
}

// The release gate sets RUN_ACME_E2E=1 and installs both pinned Go binaries.
// An explicitly requested run FAILS when they are unavailable; no skipped green.
describe.skipIf(process.env.RUN_ACME_E2E !== "1")(
  "manual DNS certificates against a real ACME CA",
  () => {
    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), "openship-acme-e2e-"));
      const { stdout } = await execute("go", ["env", "GOMODCACHE"]);
      const module = join(stdout.trim(), `github.com/letsencrypt/pebble/v2@${version}`);
      const [dns, management, ca, caManagement] = await Promise.all([
        port(),
        port(),
        port(),
        port(),
      ]);
      managementUrl = `http://127.0.0.1:${management}`;
      const config = join(directory, "pebble.json");
      await writeFile(
        config,
        JSON.stringify({
          pebble: {
            listenAddress: `127.0.0.1:${ca}`,
            managementListenAddress: `127.0.0.1:${caManagement}`,
            certificate: join(module, "test/certs/localhost/cert.pem"),
            privateKey: join(module, "test/certs/localhost/key.pem"),
            httpPort: 5002,
            tlsPort: 5001,
            externalAccountBindingRequired: false,
            retryAfter: { authz: 1, order: 1 },
          },
        }),
      );
      start("pebble-challtestsrv", [
        "-dnsserver",
        `127.0.0.1:${dns}`,
        "-management",
        `127.0.0.1:${management}`,
        "-http01",
        "",
        "-https01",
        "",
        "-tlsalpn01",
        "",
        "-doh",
        "",
      ]);
      await ready(management);
      start("pebble", ["-config", config, "-dnsserver", `127.0.0.1:${dns}`, "-strict"]);
      await ready(ca);
      options = {
        directoryUrl: `https://localhost:${ca}/dir`,
        termsOfServiceAgreed: true,
        email: "operator@example.com",
        keyType: "ec256",
        caPem: await readFile(join(module, "test/certs/pebble.minica.pem"), "utf8"),
      };
    }, 30_000);
    afterAll(async () => {
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve) => {
              if (server.exitCode !== null) return resolve();
              const timer = setTimeout(() => server.kill("SIGKILL"), 2000);
              server.once("exit", () => {
                clearTimeout(timer);
                resolve();
              });
              server.kill("SIGTERM");
            }),
        ),
      );
      if (directory) await rm(directory, { recursive: true, force: true });
    });

    it("resumes a saved wildcard order, validates real DNS and renews with a fresh TXT", async () => {
      const provider = createAcmeDnsProvider(options);
      const key = await provider.createAccountKey();
      const first = await provider.prepare("*.wildcard.example", key);
      expect(first.record.name).toBe("_acme-challenge.wildcard.example");
      expect(first.record.value).toMatch(/^[\w-]{43}$/);
      expect(Date.parse(first.expiresAt)).toBeGreaterThan(Date.now());
      await publish(first.record);
      // A new provider, with only saved state: no live process/hook is resumed.
      const reopened = createAcmeDnsProvider(options);
      const cert = await reopened.complete("*.wildcard.example", key, first.state);
      const x509 = new X509Certificate(cert.certPem);
      expect(x509.checkPrivateKey(createPrivateKey(cert.keyPem))).toBe(true);
      expect(x509.checkHost("app.wildcard.example")).toBeDefined();
      expect(x509.checkHost("wildcard.example")).toBeUndefined();
      expect(x509.checkHost("deep.app.wildcard.example")).toBeUndefined();
      expect(validateCertFor("*.wildcard.example", cert, "manual DNS").cert).not.toBeNull();
      const replay = await reopened.complete("*.wildcard.example", key, first.state);
      expect(new X509Certificate(replay.certPem).serialNumber).toBe(x509.serialNumber);
      const renewal = await reopened.prepare("*.wildcard.example", key);
      expect(renewal.record.value).not.toBe(first.record.value);
      await publish(renewal.record);
      const renewed = await reopened.complete("*.wildcard.example", key, renewal.state);
      expect(new X509Certificate(renewed.certPem).serialNumber).not.toBe(x509.serialNumber);
      expect(validateCertFor("*.wildcard.example", renewed, "renewed DNS").cert).not.toBeNull();
    }, 60_000);

    it("cannot issue without the TXT proof or reuse another hostname's order", async () => {
      const provider = createAcmeDnsProvider(options);
      const key = await provider.createAccountKey();
      const prepared = await provider.prepare("*.missing.example", key);
      await expect(provider.complete("*.different.example", key, prepared.state)).rejects.toThrow(
        /domain or certificate authority changed/,
      );
      await expect(provider.complete("*.missing.example", key, prepared.state)).rejects.toThrow();
    }, 60_000);
  },
);
