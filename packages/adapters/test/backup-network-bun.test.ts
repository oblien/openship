import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { once } from "node:events";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("enforces backup network policy and preserves TLS identity in the Bun runtime", async () => {
  const directory = mkdtempSync(join(tmpdir(), "openship-backup-tls-"));
  const key = join(directory, "key.pem");
  const cert = join(directory, "cert.pem");
  let server: ReturnType<typeof createServer> | undefined;
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        // LibreSSL otherwise emits explicit curve parameters, rejected by Bun's TLS runtime.
        "-pkeyopt",
        "ec_param_enc:named_curve",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=storage.example.test",
        "-addext",
        "subjectAltName=DNS:storage.example.test",
        "-keyout",
        key,
        "-out",
        cert,
      ],
      { stdio: "pipe", timeout: 10_000 },
    );
    const requests: unknown[] = [];
    server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
      requests.push({
        host: req.headers.host,
        authorization: req.headers.authorization,
        url: req.url,
        servername: (req.socket as import("node:tls").TLSSocket & { servername?: string })
          .servername,
      });
      res.end("pinned");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { stdout } = await promisify(execFile)(
      "bun",
      [
        "run",
        fileURLToPath(new URL("./fixtures/public-http-handler-bun.ts", import.meta.url)),
        String((server.address() as { port: number }).port),
      ],
      {
        env: { ...process.env, NODE_EXTRA_CA_CERTS: cert },
        encoding: "utf8",
        timeout: 20_000,
      },
    );
    expect(stdout).toContain("wrong certificate rejected");
    expect(requests).toEqual([
      {
        host: "storage.example.test",
        authorization: "synthetic-signature",
        url: "/a%2Fb?x=1&x=2",
        servername: "storage.example.test",
      },
    ]);
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
