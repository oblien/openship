import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type SMTPTransport from "nodemailer/lib/smtp-transport";

const fixture = vi.hoisted(() => ({
  port: 0,
  directory: "",
  mode: "plaintext" as "plaintext" | "starttls" | "tls",
  source: "instance" as "instance" | "env" | "platform",
  env: {
    CLOUD_MODE: false,
    SMTP_HOST: undefined as string | undefined,
    SMTP_PORT: 587,
    SMTP_USER: undefined as string | undefined,
    SMTP_PASS: undefined as string | undefined,
    SMTP_FROM: "sender@example.test",
  },
}));

vi.mock("@repo/platform/engine/config/env", () => ({ env: fixture.env }));
vi.mock("@repo/db", () => ({
  repos: {
    instanceSettings: {
      get: async () =>
        fixture.source === "instance"
          ? {
              smtpHost: "localhost",
              smtpPort: fixture.mode === "tls" ? 465 : fixture.port,
              smtpUser: "sender@example.test",
              smtpPasswordEncrypted: "sealed",
            }
          : null,
    },
    mailServer: {
      list: async () =>
        fixture.source === "platform"
          ? [{ serverId: "test-mail-server", installedAt: new Date() }]
          : [],
    },
  },
}));
vi.mock("@repo/platform/engine/lib/encryption", () => ({ decrypt: () => "fixture-password" }));
vi.mock("@repo/platform/engine/lib/cloud/client", () => ({ cloudClient: vi.fn() }));
vi.mock("@repo/platform/engine/modules/mail/admin/platform-mailbox.service", () => ({
  ensureOpenshipPlatformMailbox: async () => ({
    smtpHost: "localhost",
    smtpPort: fixture.mode === "tls" ? 465 : fixture.port,
    secure: fixture.mode === "tls",
    email: "sender@example.test",
    password: "fixture-password",
    from: "sender@example.test",
  }),
}));
vi.mock("nodemailer", async (original) => {
  const real = await original<{ default: typeof import("nodemailer") }>();
  return {
    default: {
      ...real.default,
      createTransport: (options: SMTPTransport.Options) =>
        real.default.createTransport({
          ...options,
          // Map privileged port 465 to a disposable listener; trust its certificate.
          // The production TLS flags and certificate verification stay intact.
          port: fixture.port,
          tls: { ...options.tls, ca: readFileSync(join(fixture.directory, "cert.pem")) },
        }),
    },
  };
});

beforeAll(() => {
  fixture.directory = mkdtempSync(join(tmpdir(), "openship-submission-test-"));
  const result = spawnSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost",
    "-keyout",
    join(fixture.directory, "key.pem"),
    "-out",
    join(fixture.directory, "cert.pem"),
  ]);
  if (result.status !== 0) throw new Error("Failed to generate SMTP fixture certificate");
});
afterAll(() => rmSync(fixture.directory, { recursive: true, force: true }));

async function localSmtp(mode: typeof fixture.mode, allowedSender?: string) {
  // Reuse the real SMTP fixture, including its per-command TLS observations.
  const child = spawn(
    "node",
    [
      fileURLToPath(
        new URL("../../../email/server/test/fixtures/smtp-server.mjs", import.meta.url),
      ),
      mode,
      fixture.directory,
      ...(allowedSender ? [allowedSender] : []),
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const commands: string[] = [];
  const credentials: Array<{ secure: boolean }> = [];
  const deliveries: Array<{ secure: boolean; from?: string; message?: string }> = [];
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const lines = createInterface({ input: child.stdout });
  const port = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => reject(new Error(`SMTP fixture exited: ${stderr}`)));
    lines.on("line", (line) => {
      const event = JSON.parse(line);
      if (event.port) resolve(event.port);
      if (event.command) commands.push(event.command);
      if (event.credential) credentials.push(event);
      if (event.delivered) deliveries.push(event);
    });
  });
  return {
    port,
    commands,
    credentials,
    deliveries,
    async close() {
      child.stdin.end("stop\n");
      const timeout = setTimeout(() => child.kill(), 1000);
      try {
        await exited;
      } finally {
        clearTimeout(timeout);
        lines.close();
      }
    },
  };
}

describe("authenticated SMTP submission", () => {
  it.each(["instance", "env", "platform"] as const)(
    "%s credentials require a verified TLS connection",
    async (source) => {
      for (const mode of ["plaintext", "starttls", "tls"] as const) {
        const smtp = await localSmtp(mode);
        try {
          fixture.source = source;
          fixture.mode = mode;
          fixture.port = smtp.port;
          fixture.env.SMTP_HOST = source === "env" ? "localhost" : undefined;
          fixture.env.SMTP_USER = source === "env" ? "sender@example.test" : undefined;
          fixture.env.SMTP_PASS = source === "env" ? "fixture-password" : undefined;
          fixture.env.SMTP_PORT = mode === "tls" ? 465 : smtp.port;
          vi.resetModules();
          const mail = await import("@repo/platform/engine/lib/mail");
          const send =
            source === "instance"
              ? mail.sendInstanceTestEmail("recipient@example.test")
              : mail.sendMail({
                  to: "recipient@example.test",
                  subject: "fixture",
                  html: "<p>fixture</p>",
                  preferSource: source === "platform" ? "platform" : "auto",
                });
          if (mode === "plaintext") {
            await expect(send).rejects.toMatchObject({ code: "ETLS" });
            // The fixture reports commands over stdout, so the client can fail before the line arrives.
            await vi.waitFor(() => expect(smtp.commands).toContain("STARTTLS"));
            expect(smtp.credentials).toEqual([]);
            expect(smtp.deliveries).toEqual([]);
          } else {
            await expect(send).resolves.toBe(source === "instance" ? undefined : true);
            await vi.waitFor(() => expect(smtp.deliveries).toHaveLength(1));
            expect(smtp.credentials).toHaveLength(1);
            expect(smtp.credentials[0]).toMatchObject({ secure: true });
            expect(smtp.deliveries[0]).toMatchObject({ secure: true });
          }
        } finally {
          await smtp.close();
        }
      }
    },
  );
  it.each(["support", "billing"] as const)(
    "delivers %s customer mail when SMTP only authorizes the configured no-reply sender",
    async (customerSender) => {
      const smtp = await localSmtp("tls", "noreply@example.test");
      const previousEnv = { ...fixture.env };
      try {
        fixture.source = "env";
        fixture.port = smtp.port;
        Object.assign(fixture.env, {
          CLOUD_MODE: true,
          SMTP_HOST: "localhost",
          SMTP_USER: "noreply@example.test",
          SMTP_PASS: "fixture-password",
          SMTP_PORT: 465,
          SMTP_FROM: "OpenShip <noreply@example.test>",
        });
        vi.resetModules();
        const { sendMail } = await import("@repo/platform/engine/lib/mail");
        await expect(
          sendMail({
            to: "customer@example.test",
            subject: "Customer mail",
            html: "<p>Customer mail</p>",
            customerSender,
            replyTo: "support@openship.io",
            messageId: "<customer-test@openship.io>",
          }),
        ).resolves.toBe(true);
        await vi.waitFor(() => expect(smtp.deliveries).toHaveLength(1));
        expect(smtp.deliveries[0]).toMatchObject({ secure: true, from: "noreply@example.test" });
        expect(smtp.deliveries[0]!.message).toContain("From: OpenShip <noreply@example.test>");
        expect(smtp.deliveries[0]!.message).toContain("Reply-To: support@openship.io");
        expect(smtp.deliveries[0]!.message).toContain("Message-ID: <customer-test@openship.io>");
      } finally {
        Object.assign(fixture.env, previousEnv);
        await smtp.close();
      }
    },
  );
});
