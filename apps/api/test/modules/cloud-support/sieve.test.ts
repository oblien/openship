import { afterAll, beforeAll, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { createServer, type Socket, type Server } from "node:net";
import { createSecureContext, TLSSocket } from "node:tls";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readSieveResponse, quoteSieve } from "../../../../../apps/email/server/src/lib/sieve";
import {
  buildBlockScript,
  readBlockScript,
} from "../../../../../apps/email/server/src/lib/blocked-senders";
it("parses fragmented literals without interpreting script contents as protocol status", async () => {
  const socket = new PassThrough(),
    script = "# comment\r\nOK\r\nNO\r\n";
  const result = readSieveResponse(socket as unknown as Socket);
  for (const byte of Buffer.from(`{${Buffer.byteLength(script)}}\r\n${script}\r\nOK\r\n`))
    socket.write(Buffer.from([byte]));
  expect(await result).toEqual({ lines: [], literals: [script], ok: true });
  socket.destroy();
});
it("rejects oversized and malformed protocol input", async () => {
  for (const input of ["{9999999}\r\n", "{3}\r\nabcXX"]) {
    const socket = new PassThrough(),
      result = readSieveResponse(socket as unknown as Socket);
    socket.write(input);
    await expect(result).rejects.toThrow();
    socket.destroy();
  }
});
it("quotes script strings, rejects injection, and preserves personal rules", () => {
  expect(quoteSieve('a"b\\c')).toBe('"a\\"b\\\\c"');
  expect(() => quoteSieve('a\r\nSETACTIVE ""')).toThrow();
  expect(() => buildBlockScript(["bad\r\n@example.com"], "")).toThrow();
  expect(() => buildBlockScript(["a@example.com"], "openship-sender-blocks")).toThrow();
  expect(() => readBlockScript("keep;")).toThrow();
  const script = buildBlockScript(["a@example.com"], "roundcube");
  expect(script).toContain('fileinto "Junk"; stop;');
  expect(script).toContain('include :personal "roundcube";');
  expect(readBlockScript(script)).toEqual({ senders: ["a@example.com"], previous: "roundcube" });
});
let directory: string, server: Server, port: number;
const sockets = new Set<Socket>(),
  scripts = new Map([["roundcube", "# existing user script\nkeep;\n"]]);
let active = "roundcube",
  authentications = 0;
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "openship-sieve-test-"));
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
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-keyout",
      join(directory, "key.pem"),
      "-out",
      join(directory, "cert.pem"),
    ],
    { stdio: "ignore" },
  );
  const context = createSecureContext({
    key: readFileSync(join(directory, "key.pem")),
    cert: readFileSync(join(directory, "cert.pem")),
  });
  server = createServer((raw) => {
    sockets.add(raw);
    raw.on("close", () => sockets.delete(raw));
    raw.on("error", () => {});
    raw.write('"STARTTLS"\r\nOK\r\n');
    let before = "";
    const upgrade = (data: Buffer) => {
      before += data.toString();
      if (!before.endsWith("\r\n")) return;
      expect(before).toBe("STARTTLS\r\n");
      raw.off("data", upgrade);
      raw.write("OK\r\n");
      const secure = new TLSSocket(raw, { isServer: true, secureContext: context });
      secure.on("error", () => {});
      secure.on("secure", () => {
        secure.write('"SASL" "PLAIN"\r\n"SIEVE" "fileinto include"\r\nOK\r\n');
      });
      let buffer = Buffer.alloc(0),
        pending: { name: string; length: number } | null = null;
      secure.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        for (;;) {
          if (pending) {
            if (buffer.length < pending.length + 2) return;
            scripts.set(pending.name, buffer.subarray(0, pending.length).toString());
            buffer = buffer.subarray(pending.length + 2);
            pending = null;
            secure.write("OK\r\n");
            continue;
          }
          const end = buffer.indexOf("\r\n");
          if (end < 0) return;
          const line = buffer.subarray(0, end).toString();
          buffer = buffer.subarray(end + 2);
          if (line.startsWith("AUTHENTICATE ")) {
            expect(
              Buffer.from(
                JSON.parse(line.slice('AUTHENTICATE "PLAIN" '.length)),
                "base64",
              ).toString(),
            ).toBe("\0owner@example.com\0test-password");
            authentications++;
            secure.write("OK\r\n");
          } else if (line === "LISTSCRIPTS")
            secure.write(
              [...scripts.keys()]
                .map((name) => JSON.stringify(name) + (name === active ? " ACTIVE" : ""))
                .join("\r\n") + "\r\nOK\r\n",
            );
          else if (line.startsWith("GETSCRIPT ")) {
            const script = scripts.get(JSON.parse(line.slice(10)))!;
            secure.write(`{${Buffer.byteLength(script)}}\r\n${script}\r\nOK\r\n`);
          } else if (line.startsWith("PUTSCRIPT ")) {
            const match = line.match(/^PUTSCRIPT ("(?:[^"\\]|\\.)*") \{(\d+)\+\}$/)!;
            pending = { name: JSON.parse(match[1]!), length: Number(match[2]) };
          } else if (line.startsWith("SETACTIVE ")) {
            active = JSON.parse(line.slice(10));
            secure.write("OK\r\n");
          } else secure.write("NO\r\n");
        }
      });
    };
    raw.on("data", upgrade);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});
afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (directory) rmSync(directory, { recursive: true, force: true });
});
it("updates filters over real verified STARTTLS and restores the original personal script", async () => {
  const module = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../../apps/email/server/src/lib/blocked-senders.ts",
  );
  const source = `import {setSenderBlocked,listBlockedSenders} from ${JSON.stringify(module)};
    const auth={host:'127.0.0.1',port:993,user:'owner@example.com',pass:'test-password'};
    const first=await setSenderBlocked(auth,'Spam@Example.com',true); await setSenderBlocked(auth,'second@example.com',true);
    const listed=await listBlockedSenders(auth); await setSenderBlocked(auth,'spam@example.com',false);
    const last=await setSenderBlocked(auth,'second@example.com',false); console.log(JSON.stringify({first,listed,last}));`;
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn("bun", ["--eval", source], {
      env: {
        ...process.env,
        DEFAULT_SIEVE_HOST: "127.0.0.1",
        DEFAULT_SIEVE_PORT: String(port),
        NODE_EXTRA_CA_CERTS: join(directory, "cert.pem"),
        SESSION_ENCRYPTION_KEY: "0".repeat(64),
        BRANDING_ADMIN_TOKEN: "test-only-token",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Sieve test timed out: " + stderr));
    }, 25_000);
    child.stdout.on("data", (data) => (stdout += data));
    child.stderr.on("data", (data) => (stderr += data));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve(stdout) : reject(new Error(stderr));
    });
  });
  const result = JSON.parse(output.trim());
  expect(result.first).toEqual({ senders: ["spam@example.com"], active: true });
  expect(result.listed).toEqual({
    senders: ["second@example.com", "spam@example.com"],
    active: true,
  });
  expect(result.last).toEqual({ senders: [], active: false });
  expect(active).toBe("roundcube");
  expect(scripts.get("roundcube")).toBe("# existing user script\nkeep;\n");
  expect(authentications).toBe(5);
}, 30_000);
it("refuses an untrusted TLS certificate before sending mailbox credentials", async () => {
  const module = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../../apps/email/server/src/lib/blocked-senders.ts",
  );
  const before = authentications;
  const source = `import {listBlockedSenders} from ${JSON.stringify(module)}; await listBlockedSenders({host:'127.0.0.1',port:993,user:'owner@example.com',pass:'test-password'});`;
  const result = await new Promise<{ code: number | null; error: string }>((resolve, reject) => {
    const child = spawn("bun", ["--eval", source], {
      env: {
        ...process.env,
        DEFAULT_SIEVE_HOST: "127.0.0.1",
        DEFAULT_SIEVE_PORT: String(port),
        NODE_EXTRA_CA_CERTS: "",
        SESSION_ENCRYPTION_KEY: "0".repeat(64),
        BRANDING_ADMIN_TOKEN: "test-only-token",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let error = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("TLS rejection timed out"));
    }, 15_000);
    child.stderr.on("data", (data) => (error += data));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, error });
    });
  });
  expect(result.code).not.toBe(0);
  expect(result.error).toMatch(/certificate|self.signed|verify/i);
  expect(authentications).toBe(before);
}, 20_000);
