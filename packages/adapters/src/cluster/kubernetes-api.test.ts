import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:https";
import net from "node:net";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createKubernetesApi, type KubernetesApi } from "./kubernetes-api";

let directory: string;
let cert: string;
let key: string;
const servers: Server[] = [];
const clients: KubernetesApi[] = [];

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "openship-kubernetes-tls-"));
  writeFileSync(
    join(directory, "openssl.cnf"),
    "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=private-api\n[ext]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n",
  );
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-config",
      join(directory, "openssl.cnf"),
      "-keyout",
      join(directory, "key.pem"),
      "-out",
      join(directory, "cert.pem"),
    ],
    { stdio: "ignore" },
  );
  cert = readFileSync(join(directory, "cert.pem"), "utf8");
  key = readFileSync(join(directory, "key.pem"), "utf8");
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.dispose()));
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

async function fixture(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  host = "127.0.0.1",
) {
  const server = createServer(
    { cert, key, ca: cert, requestCert: true, rejectUnauthorized: true },
    handler,
  );
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as net.AddressInfo).port;
  const api = createKubernetesApi({
    host,
    cert,
    key,
    ca: cert,
    connect: async () => net.connect({ host: "127.0.0.1", port }),
  });
  clients.push(api);
  return api;
}

describe("private Kubernetes API transport", () => {
  it("verifies the server and presents its client certificate through the forwarded channel", async () => {
    const api = await fixture((request, response) => {
      if (!(globalThis as { Bun?: unknown }).Bun)
        expect((request.socket as import("node:tls").TLSSocket).authorized).toBe(true);
      response.end(JSON.stringify({ metadata: { uid: "verified-cluster" } }));
    });
    expect((await api.request("GET", "/api/v1/namespaces/kube-system")).metadata.uid).toBe(
      "verified-cluster",
    );
  });

  it("rejects a different private API identity even when its certificate is trusted", async () => {
    let reached = false;
    const api = await fixture((_request, response) => {
      reached = true;
      response.end("{}");
    }, "127.0.0.2");
    await expect(api.request("GET", "/api/v1/nodes")).rejects.toThrow(/IP|certificate|altname/i);
    expect(reached).toBe(false);
  });

  it("does not replay an ambiguous mutation after the server accepted its body", async () => {
    let attempts = 0;
    const api = await fixture((request) => {
      attempts++;
      request.resume();
      request.on("end", () => request.socket.destroy());
    });
    await expect(
      api.request("POST", "/api/v1/namespaces", { metadata: { name: "release" } }),
    ).rejects.toThrow();
    expect(attempts).toBe(1);
  });

  it("suppresses admission responses that can contain submitted secret data", async () => {
    const api = await fixture((_request, response) => {
      response.writeHead(422);
      response.end(JSON.stringify({ message: "invalid secret: private-registry-password" }));
    });
    await expect(api.request("POST", "/api/v1/namespaces/p/secrets", {})).rejects.toThrow(
      "Kubernetes secret operation failed (HTTP 422)",
    );
  });

  it("decodes split UTF-8 watch frames and closes an abandoned stream", async () => {
    let closed: Promise<unknown> | undefined;
    const api = await fixture((_request, response) => {
      closed = (globalThis as { Bun?: unknown }).Bun ? undefined : once(response, "close");
      const bytes = Buffer.from(
        JSON.stringify({ type: "MODIFIED", object: { metadata: { name: "خادم" } } }) + "\n",
      );
      const split = bytes.indexOf(Buffer.from("خ")) + 1;
      response.write(bytes.subarray(0, split));
      setTimeout(() => response.write(bytes.subarray(split)), 5);
    });
    for await (const event of api.watch("/api/v1/pods?watch=1", new AbortController().signal)) {
      expect(event.object.metadata.name).toBe("خادم");
      break;
    }
    await closed;
  });
});
