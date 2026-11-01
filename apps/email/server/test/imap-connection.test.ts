import { afterAll, afterEach, beforeAll, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { ImapFlow, type ImapFlowOptions } from "imapflow";
import { probeImap, withImap } from "../src/lib/imap";
import { classifyImapFailure } from "../src/lib/imap-errors";

let dir: string;
let cert: Buffer;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "openship-test-imap-"));
  writeFileSync(
    join(dir, "openssl.cnf"),
    "[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=cert\n[dn]\nCN=localhost\n[cert]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n",
  );
  const result = spawnSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-config",
    join(dir, "openssl.cnf"),
    "-keyout",
    join(dir, "key.pem"),
    "-out",
    join(dir, "cert.pem"),
  ]);
  if (result.status !== 0) throw new Error(`Test certificate generation failed: ${result.stderr}`);
  cert = readFileSync(join(dir, "cert.pem"));
});
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});
afterEach(() => mock.restore());

type Reply = "success" | "AUTHENTICATIONFAILED" | "UNAVAILABLE" | "disconnect";
async function localImap(
  mode: "tls" | "starttls" | "plaintext",
  reply: Reply = "success",
  commandLogDelayMs = 0,
) {
  // Node supplies the fixture server so Bun's server-side STARTTLS emulation
  // cannot hide a problem in the production Bun IMAP client.
  const child = spawn(
    "node",
    [join(import.meta.dir, "fixtures/imap-server.mjs"), mode, reply, dir, String(commandLogDelayMs)],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const credentials: string[] = [];
  const commands: string[] = [];
  const sockets = { size: 0 };
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const lines = createInterface({ input: child.stdout });
  const port = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => reject(new Error(`IMAP fixture exited: ${stderr}`)));
    lines.on("line", (line) => {
      const event = JSON.parse(line);
      if (event.port) resolve(event.port);
      if (event.credential) credentials.push(event.credential);
      if (event.command) commands.push(event.command);
      if (event.connection) sockets.size += event.connection;
    });
  });
  return {
    port,
    credentials,
    commands,
    sockets,
    async close() {
      child.stdin.end("stop\n");
      const deadline = setTimeout(() => child.kill(), 1000);
      try {
        await exited;
      } finally {
        clearTimeout(deadline);
        lines.close();
      }
    },
  };
}

// Redirect only the socket destination to a loopback fixture. The production
// client still selects IMAPS/STARTTLS from the configured port and validates TLS.
// Trust the test certificate explicitly; never disable certificate validation.
function routeTo(port: number, trust = true) {
  const connect = ImapFlow.prototype.connect;
  spyOn(ImapFlow.prototype, "connect").mockImplementation(function (this: ImapFlow) {
    const client = this as ImapFlow & {
      host: string;
      port: number;
      servername: string;
      options: ImapFlowOptions;
    };
    client.host = "127.0.0.1";
    client.port = port;
    client.servername = "localhost";
    client.options.tls = { ...(trust ? { ca: cert } : {}), servername: "localhost" };
    return connect.call(this);
  });
}
const auth = (port = 993) => ({
  host: "mail.example.test",
  port,
  user: "user@example.test",
  pass: "test-only-password",
});

describe("webmail over real local IMAP sockets", () => {
  it("keeps the authenticated SSE response alive beyond Bun's ordinary idle timeout", async () => {
    const fixture = await localImap("tls");
    routeTo(fixture.port);
    const { default: application } = await import("../src/main");
    const { saveSession, deleteSession } = await import("../src/lib/session");
    const { env } = await import("../src/env");
    const session = await saveSession({
      email: "idle-runtime@example.test", password: "test-only-password",
      imapHost: "mail.example.test", imapPort: 993,
      smtpHost: "mail.example.test", smtpPort: 587,
    });
    const http = Bun.serve({ ...application, port: 0, idleTimeout: 1 });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await fetch(`http://127.0.0.1:${http.port}/mail/idle?view=inbox`, {
        headers: { Cookie: `${env.SESSION_COOKIE_NAME}=${session.id}` },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('X-Accel-Buffering')).toBe('no');
      reader = response.body!.getReader();
      const ready = await reader.read();
      expect(new TextDecoder().decode(ready.value)).toContain('event: mailbox');
      // Bun's timeout sweep runs in four-second steps. No heartbeat is due
      // for 25 seconds, so an ordinary one-second timeout would close here.
      await Bun.sleep(4500);
      expect(http.pendingRequests).toBe(1);
      const health = await fetch(`http://127.0.0.1:${http.port}/health`);
      expect(health.status).toBe(200);
      for (const { query, mailbox } of [
        { query: 'view=bin', mailbox: 'Trash' },
        { query: 'view=draft', mailbox: 'Drafts' },
        { query: 'view=starred', mailbox: 'INBOX' },
        { query: 'folder=Personal', mailbox: 'Personal' },
      ]) {
        const mapped = await fetch(`http://127.0.0.1:${http.port}/mail/idle?${query}`, {
          headers: { Cookie: `${env.SESSION_COOKIE_NAME}=${session.id}` },
        });
        const mappedReader = mapped.body!.getReader();
        try {
          const event = await mappedReader.read();
          expect(new TextDecoder().decode(event.value)).toContain(`"folder":"${mailbox}"`);
        } finally { await mappedReader.cancel(); }
      }
    } finally {
      await reader?.cancel();
      http.stop(true);
      await deleteSession(session.id);
      await fixture.close();
    }
  }, 15_000);

  it.each(["tls", "starttls"] as const)(
    "authenticates and opens the inbox using %s",
    async (mode) => {
      const server = await localImap(mode, "success", 50);
      try {
        routeTo(server.port);
        const exists = await withImap(
          auth(mode === "tls" ? 993 : 143),
          async (client) => (await client.mailboxOpen("INBOX")).exists,
        );
        expect(exists).toBe(1);
        expect(server.credentials).toEqual(["\0user@example.test\0test-only-password"]);
        // A successful socket response does not flush the child's stdout pipe.
        const deadline = Date.now() + 1000;
        while (!server.commands.includes("LOGOUT") && Date.now() < deadline) await Bun.sleep(5);
        expect(server.commands).toContain("LOGOUT");
        if (mode === "starttls")
          expect(server.commands.indexOf("STARTTLS")).toBeLessThan(
            server.commands.indexOf("AUTHENTICATE"),
          );
      } finally {
        await server.close();
      }
    },
  );

  it.each(["AUTHENTICATIONFAILED", "UNAVAILABLE", "disconnect"] as const)(
    "distinguishes %s over the wire",
    async (reply) => {
      const server = await localImap("tls", reply);
      try {
        routeTo(server.port);
        if (reply === "AUTHENTICATIONFAILED") expect(await probeImap(auth())).toBe(false);
        else {
          const error = await probeImap(auth()).then(
            () => null,
            (error) => error,
          );
          expect(error).toBeInstanceOf(Error);
          expect(classifyImapFailure(error)).toBe(
            reply === "UNAVAILABLE" ? "unavailable" : "connection",
          );
        }
        const deadline = Date.now() + 1000;
        while (server.sockets.size && Date.now() < deadline) await Bun.sleep(5);
        expect(server.sockets.size).toBe(0);
      } finally {
        await server.close();
      }
    },
  );

  it("refuses an untrusted certificate before sending credentials", async () => {
    const server = await localImap("tls");
    try {
      routeTo(server.port, false);
      const error = await probeImap(auth()).then(
        () => null,
        (error) => error,
      );
      expect(classifyImapFailure(error)).toBe("tls");
      expect(server.credentials).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("refuses a plaintext-only backend before sending credentials", async () => {
    const server = await localImap("plaintext");
    try {
      routeTo(server.port);
      const error = await probeImap(auth(143)).then(
        () => null,
        (error) => error,
      );
      expect(classifyImapFailure(error)).toBe("tls");
      expect(server.credentials).toEqual([]);
      expect(server.commands).not.toContain("AUTHENTICATE");
    } finally {
      await server.close();
    }
  });
});
