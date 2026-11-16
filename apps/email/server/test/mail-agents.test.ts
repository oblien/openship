import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db, schema } from "../src/db";
import { mailboxId, type MailboxCredentials } from "../src/mail/identity";
import { authenticateGrant, createGrant, listGrants, revokeGrant } from "../src/mail/grants";
import {
  approveJob,
  cancelJob,
  enqueueSend,
  jobDetails,
  listJobs,
  readJob,
  rescheduleJob,
  runOutboxPass,
} from "../src/mail/outbox";
import { mailRouteInternals, prepareMessage, sendInput } from "../src/mail/messages";
import { mailMcpRoutes } from "../src/mail/mcp";
import { encryptSecret, decryptSecret } from "../src/lib/crypto";
import { saveSession, deleteSession } from "../src/lib/session";
import * as driver from "../src/lib/imap-driver";
import { snooze, unsnooze } from "../src/mail/outbox";
import { purgeExpiredGrants } from "../src/mail/grants";
import { composeRfc822, decodeAttachments } from "../src/lib/smtp";
import { simpleParser } from "mailparser";
import { env } from "../src/env";
import * as imap from "../src/lib/imap";
import { createDraft } from "../src/mail/drafts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const alice: MailboxCredentials = {
  email: "alice@example.test",
  name: "Alice",
  password: "alice-password",
  imapHost: "mail.example.test",
  imapPort: 993,
  smtpHost: "mail.example.test",
  smtpPort: 587,
};
const bob: MailboxCredentials = { ...alice, email: "bob@example.test", password: "bob-password" };
const message = {
  from: alice.email,
  message: { to: ["recipient@example.test"], subject: "Private subject", text: "Private contents" },
};
let send: ReturnType<typeof spyOn<typeof mailRouteInternals, "send">>;
beforeEach(() => {
  db.delete(schema.mailJob).run();
  db.delete(schema.mailGrant).run();
  send = spyOn(mailRouteInternals, "send").mockResolvedValue({ messageId: "<sent@example.test>" });
});
afterEach(() => send.mockRestore());

describe("mailbox authority", () => {
  it("distinguishes backends, survives session changes, and cannot swap encrypted records", () => {
    expect(mailboxId({ ...alice, password: "new-password" })).toBe(mailboxId(alice));
    expect(mailboxId({ ...alice, imapHost: "other.example.test" })).not.toBe(mailboxId(alice));
    const encrypted = encryptSecret("private", `mail:${mailboxId(alice)}`);
    expect(() => decryptSecret(encrypted, `mail:${mailboxId(bob)}`)).toThrow();
  });
  it("binds expiring agent tokens to exactly one mailbox and scope", () => {
    const grant = createGrant(alice, { name: "Reader", scopes: ["mail:read"], expiresInDays: 1 });
    expect(authenticateGrant(grant.token, "mail:read")?.mailbox.email).toBe(alice.email);
    expect(authenticateGrant(grant.token, "mail:send")).toBeNull();
    expect(listGrants(bob)).toHaveLength(0);
    expect(() => revokeGrant(bob, grant.id)).toThrow("not found");
    expect(db.select().from(schema.mailGrant).get()?.tokenHash).not.toContain(grant.token);
    revokeGrant(alice, grant.id);
    expect(authenticateGrant(grant.token)).toBeNull();
    expect(db.select().from(schema.mailGrant).get()?.credentials).toBeNull();
  });
  it("validates recipients and keeps commas in display names inside one address", async () => {
    expect(sendInput.safeParse({ to: [], subject: "x" }).success).toBe(false);
    expect(
      sendInput.safeParse({ to: ["a@example.test"], subject: "x\r\nBcc: attacker@example.test" })
        .success,
    ).toBe(false);
    const input = sendInput.parse({
      to: [{ email: "a@example.test", name: "hidden@example.test, Reader" }],
      subject: "hello",
    });
    const prepared = await prepareMessage(alice, input);
    expect(prepared.message.to).toEqual(['"hidden@example.test, Reader" <a@example.test>']);
    await expect(prepareMessage(alice, { ...input, fromEmail: bob.email })).rejects.toThrow(
      "signed-in mailbox",
    );
  });
  it("revokes child tokens and pending proposals when parent permission expires", () => {
    const parent = createGrant(alice, {
      name: "Consent",
      internal: true,
      scopes: ["mail:read", "mail:send"],
      expiresInDays: 1,
    });
    const child = createGrant(alice, {
      name: "Turn",
      internal: true,
      parentId: parent.id,
      scopes: ["mail:read"],
      expiresInDays: 1,
    });
    expect(() =>
      createGrant(bob, {
        name: "Invalid",
        parentId: parent.id,
        scopes: ["mail:read"],
        expiresInDays: 1,
      }),
    ).toThrow("parent connection");
    const job = enqueueSend(alice, message, undefined, { grantId: parent.id });
    db.update(schema.mailGrant)
      .set({ expiresAt: Date.now() - 1 })
      .where(eq(schema.mailGrant.id, parent.id))
      .run();
    purgeExpiredGrants();
    expect(authenticateGrant(child.token)).toBeNull();
    expect(readJob(alice, job.messageId).state).toBe("cancelled");
    expect(
      db.select().from(schema.mailGrant).where(eq(schema.mailGrant.id, child.id)).get()
        ?.credentials,
    ).toBeNull();
  });
});

describe("durable sends and approvals", () => {
  it("filters scheduled mail before pagination, keeps delivery issues visible, and scopes both views", () => {
    const later = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
    const pending = [30, 10, 20].map((minutes) => enqueueSend(alice, message, later(minutes)));
    const failures = (["failed", "uncertain"] as const).map((state, index) => {
      const job = enqueueSend(alice, message, later(5 + index));
      db.update(schema.mailJob).set({ state }).where(eq(schema.mailJob.id, job.messageId)).run();
      return job.messageId;
    });
    const grant = createGrant(alice, { name: "Agent", scopes: ["mail:send"], expiresInDays: 1 });
    const proposal = enqueueSend(alice, message, undefined, { grantId: grant.id });
    for (let i = 0; i < 21; i++) {
      const job = enqueueSend(alice, message, later(1));
      cancelJob(alice, job.messageId);
    }
    const sent = enqueueSend(alice, message, later(1));
    db.update(schema.mailJob)
      .set({ state: "done" })
      .where(eq(schema.mailJob.id, sent.messageId))
      .run();
    enqueueSend(bob, message, later(1));
    const bobCancelled = enqueueSend(bob, message, later(1));
    cancelJob(bob, bobCancelled.messageId);

    const upcoming = listJobs(alice, 0, "upcoming");
    expect(upcoming.hasMore).toBe(false);
    expect(upcoming.items).toHaveLength(6);
    expect(upcoming.items.map((item) => item.id)).toEqual([
      proposal.messageId,
      ...failures,
      pending[1].messageId,
      pending[2].messageId,
      pending[0].messageId,
    ]);
    const first = listJobs(alice, 0, "history");
    const second = listJobs(alice, 20, "history");
    expect(first.items).toHaveLength(20);
    expect(first.hasMore).toBe(true);
    expect(second.items).toHaveLength(2);
    expect(second.hasMore).toBe(false);
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(22);
    expect(
      [...first.items, ...second.items].every((item) => ["done", "cancelled"].includes(item.state)),
    ).toBe(true);
    expect(listJobs(bob, 0, "upcoming").items).toHaveLength(1);
    expect(listJobs(bob, 0, "history").items.map((item) => item.id)).toEqual([
      bobCancelled.messageId,
    ]);
    expect(listJobs(alice).items).toHaveLength(20);
  });

  it("keeps scheduled mail after browser sign-out, scopes reads, and cancels before dispatch", async () => {
    const session = await saveSession(alice);
    const queued = enqueueSend(alice, message, new Date(Date.now() + 60_000).toISOString());
    await deleteSession(session.id);
    expect(listJobs(alice).items).toHaveLength(1);
    expect(listJobs(bob).items).toHaveLength(0);
    expect(() => jobDetails(bob, queued.messageId)).toThrow("not found");
    expect(() => cancelJob(bob, queued.messageId)).toThrow("not found");
    await runOutboxPass();
    expect(send).not.toHaveBeenCalled();
    cancelJob(alice, queued.messageId);
    await runOutboxPass(Date.now() + 120_000);
    expect(send).not.toHaveBeenCalled();
    expect(readJob(alice, queued.messageId).credentials).toBeNull();
  });
  it("uses one durable message for a retried request and encrypts content at rest", async () => {
    const requestId = crypto.randomUUID();
    const first = enqueueSend(alice, message, undefined, { requestId });
    const again = enqueueSend(alice, message, undefined, { requestId });
    expect(again.messageId).toBe(first.messageId);
    expect(() =>
      enqueueSend(
        alice,
        { ...message, message: { ...message.message, subject: "changed" } },
        undefined,
        { requestId },
      ),
    ).toThrow("different message");
    const row = readJob(alice, first.messageId);
    expect(row.payload.toString()).not.toContain("Private");
    await Promise.all([runOutboxPass(Date.now() + 30_000), runOutboxPass(Date.now() + 30_000)]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(readJob(alice, first.messageId).state).toBe("done");
  });
  it("requires owner approval of the exact revision, and revocation cancels queued work", async () => {
    const grant = createGrant(alice, { name: "Sender", scopes: ["mail:send"], expiresInDays: 1 });
    const proposed = enqueueSend(alice, message, undefined, { grantId: grant.id });
    await runOutboxPass(Date.now() + 60_000);
    expect(send).not.toHaveBeenCalled();
    expect(() => approveJob(bob, proposed.messageId, 1)).toThrow("not found");
    expect(() => approveJob(alice, proposed.messageId, 2)).toThrow("changed");
    approveJob(alice, proposed.messageId, 1);
    expect(() => approveJob(alice, proposed.messageId, 1)).toThrow("changed");
    expect(() => rescheduleJob(alice, proposed.messageId, 2)).toThrow("Cancel this agent proposal");
    revokeGrant(alice, grant.id);
    await runOutboxPass(Date.now() + 60_000);
    expect(send).not.toHaveBeenCalled();
    expect(readJob(alice, proposed.messageId).state).toBe("cancelled");
  });
  it("does not blindly resend when SMTP acknowledgement is uncertain", async () => {
    send.mockRejectedValueOnce(new Error("connection lost after DATA"));
    const queued = enqueueSend(alice, message);
    await runOutboxPass(Date.now() + 30_000);
    await runOutboxPass(Date.now() + 60_000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(readJob(alice, queued.messageId).state).toBe("uncertain");
  });
  it("makes cancellation lose cleanly after dispatch has started", async () => {
    let complete!: () => void;
    send.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = () => resolve({ messageId: "<sent>" });
        }),
    );
    const queued = enqueueSend(alice, message);
    const pass = runOutboxPass(Date.now() + 30_000);
    expect(() => cancelJob(alice, queued.messageId)).toThrow("already started");
    complete();
    await pass;
    expect(readJob(alice, queued.messageId).state).toBe("done");
  });
  it("quarantines interrupted claims without replaying them", async () => {
    const queued = enqueueSend(alice, message);
    db.update(schema.mailJob)
      .set({ state: "running", updatedAt: Date.now() - 360_000 })
      .where(eq(schema.mailJob.id, queued.messageId))
      .run();
    await runOutboxPass();
    expect(send).not.toHaveBeenCalled();
    expect(readJob(alice, queued.messageId).state).toBe("uncertain");
  });
  it("uses the existing sanitizer for HTML approval previews", () => {
    const queued = enqueueSend(alice, {
      from: alice.email,
      message: {
        ...message.message,
        html: '<p>Hello <a href="https://example.test">link</a></p><img src="https://tracker.test/a" onerror="alert(1)"><script>alert(1)</script>',
      },
    });
    const review = jobDetails(alice, queued.messageId);
    expect(review.previewHtml).toContain("https://example.test");
    expect(review.previewHtml).not.toMatch(/onerror|<script|src="https:\/\/tracker/);
  });
  it("restores scheduled content in a fresh process with the same instance identity", async () => {
    const queued = enqueueSend(alice, message, new Date(Date.now() + 3_600_000).toISOString());
    const script = `import { jobDetails } from './src/mail/outbox'; console.log(JSON.stringify(jobDetails(JSON.parse(process.argv[1]), process.argv[2]).payload));`;
    const child = Bun.spawn(
      [process.execPath, "-e", script, JSON.stringify(alice), queued.messageId],
      {
        cwd: new URL("..", import.meta.url).pathname,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          SQLITE_PATH: env.SQLITE_PATH,
          SESSION_ENCRYPTION_KEY: env.SESSION_ENCRYPTION_KEY,
        },
      },
    );
    const output = await new Response(child.stdout).text();
    const errors = await new Response(child.stderr).text();
    const exit = await child.exited;
    if (exit !== 0) throw new Error(errors);
    expect(JSON.parse(output)).toEqual(message);
  });
});

describe("snooze wake-ups", () => {
  it("recovers an interrupted wake-up without replaying an interrupted send", async () => {
    const add = spyOn(driver, "snoozeThreads").mockResolvedValue();
    const wake = spyOn(driver, "unsnoozeThreads").mockResolvedValue();
    try {
      const now = Date.now();
      const job = await snooze(alice, ["sleeping"], new Date(now + 30_000).toISOString());
      const queued = enqueueSend(alice, message);
      for (const id of [job.id, queued.messageId]) {
        db.update(schema.mailJob)
          .set({ state: "running", updatedAt: now - 360_000, dueAt: now - 1 })
          .where(eq(schema.mailJob.id, id))
          .run();
      }
      await runOutboxPass(now);
      expect(wake.mock.calls.map((call) => call[1].ids)).toEqual([["sleeping"]]);
      expect(readJob(alice, job.id).state).toBe("done");
      expect(readJob(alice, queued.messageId).state).toBe("uncertain");
      expect(send).not.toHaveBeenCalled();
    } finally {
      add.mockRestore();
      wake.mockRestore();
    }
  });

  it("retries an unavailable mailbox later and respects re-snoozing in the meantime", async () => {
    const add = spyOn(driver, "snoozeThreads").mockResolvedValue();
    const wake = spyOn(driver, "unsnoozeThreads")
      .mockRejectedValueOnce(new Error("IMAP connection unavailable"))
      .mockResolvedValue();
    try {
      const now = Date.now();
      const first = await snooze(alice, ["one", "two"], new Date(now + 30_000).toISOString());
      await runOutboxPass(now + 60_000);
      expect(readJob(alice, first.id).state).toBe("pending");
      expect(readJob(alice, first.id).credentials).not.toBeNull();
      await runOutboxPass(now + 61_000);
      expect(wake).toHaveBeenCalledTimes(1);
      await snooze(alice, ["one"], new Date(now + 600_000).toISOString());
      await runOutboxPass(now + 180_000);
      expect(wake.mock.calls.map((call) => call[1].ids)).toEqual([["one", "two"], ["two"]]);
      expect(readJob(alice, first.id).state).toBe("done");
      expect(readJob(alice, first.id).credentials).toBeNull();
    } finally {
      add.mockRestore();
      wake.mockRestore();
    }
  });

  it("wakes only the messages still belonging to a schedule after re-snoozing and manual unsnooze", async () => {
    const add = spyOn(driver, "snoozeThreads").mockResolvedValue();
    const wake = spyOn(driver, "unsnoozeThreads").mockResolvedValue();
    try {
      const first = await snooze(
        alice,
        ["one", "two", "three"],
        new Date(Date.now() + 30_000).toISOString(),
      );
      await snooze(alice, ["one"], new Date(Date.now() + 120_000).toISOString());
      await unsnooze(alice, ["three"]);
      expect(jobDetails(alice, first.id).payload).toEqual({ ids: ["two"] });
      await runOutboxPass(Date.now() + 60_000);
      expect(wake.mock.calls.map((call) => call[1].ids)).toEqual([["three"], ["two"]]);
      await runOutboxPass(Date.now() + 180_000);
      expect(wake.mock.calls[2]![1].ids).toEqual(["one"]);
      expect(add).toHaveBeenCalledTimes(2);
      expect(send).not.toHaveBeenCalled();
    } finally {
      add.mockRestore();
      wake.mockRestore();
    }
  });
});

describe("shared MIME encoding", () => {
  it("keeps Unicode, attachments and private Bcc in saved drafts and Sent copies", async () => {
    const mime = await composeRfc822({
      from: alice.email,
      to: ["recipient@example.test"],
      bcc: ["private@example.test"],
      subject: "Hello مرحبًا",
      text: "Plain contents",
      html: "<p>HTML contents</p>",
      attachments: decodeAttachments([
        {
          name: "file.txt",
          type: "text/plain",
          base64: Buffer.from("file bytes").toString("base64"),
        },
      ]),
    });
    const parsed = await simpleParser(mime);
    expect(parsed.subject).toBe("Hello مرحبًا");
    expect(parsed.bcc.text).toBe("private@example.test");
    expect(parsed.attachments[0].content.toString()).toBe("file bytes");
    expect(parsed.html).toBe("<p>HTML contents</p>");
  });
  it("reuses exact Message-ID lookup and preserves the old draft until APPEND succeeds", async () => {
    const operations: unknown[] = [];
    let accept = true;
    const client = {
      getMailboxLock: async () => ({ release() {} }),
      search: async () => [1, 2],
      async *fetch() {
        yield { uid: 1, envelope: { messageId: "<Draft@example.test>" } };
        yield { uid: 2, envelope: { messageId: "<draft@example.test>" } };
      },
      append: async () => {
        operations.push("append");
        return accept ? { uid: 3 } : false;
      },
      messageDelete: async (uids: number[]) => {
        operations.push(uids);
        return true;
      },
    };
    const connection = spyOn(imap, "withImap").mockImplementation(async (_auth, use) =>
      use(client as never),
    );
    try {
      const input = {
        id: "<Draft@example.test>",
        to: "recipient@example.test",
        subject: "Updated",
        body: "Draft text",
      };
      await createDraft(alice, input);
      expect(operations).toEqual(["append", [1]]);
      operations.length = 0;
      accept = false;
      await expect(createDraft(alice, input)).rejects.toThrow("Could not save");
      expect(operations).toEqual(["append"]);
    } finally {
      connection.mockRestore();
    }
  });
});

describe("mail MCP transport", () => {
  const app = new Hono().route("/mcp", mailMcpRoutes);
  const request = (
    token: string,
    method: string,
    params = {},
    extra: Record<string, string> = {},
  ) =>
    app.request("/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...extra,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  it("supports the standard MCP initialize and tools handshake over HTTP", async () => {
    const grant = createGrant(alice, {
      name: "SDK reader",
      scopes: ["mail:read"],
      expiresInDays: 1,
    });
    const listener = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
    const client = new Client({ name: "mail-fixture", version: "1.0.0" });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${listener.port}/mcp`), {
          requestInit: { headers: { Authorization: `Bearer ${grant.token}` } },
        }),
      );
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
        "mail_search",
        "mail_read",
      ]);
      const result = await client.callTool({ name: "mail_prepare_send", arguments: {} });
      expect(result.isError).toBe(true);
    } finally {
      await client.close();
      listener.stop(true);
    }
  });
  it("rejects dashboard/session credentials, hostile origins, and revoked tokens", async () => {
    expect((await request("dashboard-token", "tools/list")).status).toBe(401);
    const grant = createGrant(alice, { name: "Reader", scopes: ["mail:read"], expiresInDays: 1 });
    expect(
      (await request(grant.token, "tools/list", {}, { Origin: "https://attacker.test" })).status,
    ).toBe(403);
    const result = await (await request(grant.token, "tools/list")).json();
    expect(result.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "mail_search",
      "mail_read",
    ]);
    const forbidden = await (
      await request(grant.token, "tools/call", { name: "mail_prepare_send", arguments: {} })
    ).json();
    expect(forbidden.result.isError).toBe(true);
    revokeGrant(alice, grant.id);
    expect((await request(grant.token, "tools/list")).status).toBe(401);
  });
  it("creates a proposal but exposes no approval tool, even with approved:true", async () => {
    const grant = createGrant(alice, { name: "Sender", scopes: ["mail:send"], expiresInDays: 1 });
    const response = await (
      await request(grant.token, "tools/call", {
        name: "mail_prepare_send",
        arguments: {
          to: message.message.to,
          subject: "Proposed",
          text: "Please send",
          approved: true,
          mailboxId: mailboxId(bob),
        },
      })
    ).json();
    expect(response.result.isError).toBeUndefined();
    expect(listJobs(alice).items[0].state).toBe("approval");
    expect(listJobs(bob).items).toHaveLength(0);
    await runOutboxPass(Date.now() + 30_000);
    expect(send).not.toHaveBeenCalled();
    const approval = await (
      await request(grant.token, "tools/call", { name: "approveJob", arguments: {} })
    ).json();
    expect(approval.result.isError).toBe(true);
  });
  it("cannot forward mailbox content using send permission alone", async () => {
    const grant = createGrant(alice, {
      name: "Sender only",
      scopes: ["mail:send"],
      expiresInDays: 1,
    });
    const response = await (
      await request(grant.token, "tools/call", {
        name: "mail_prepare_send",
        arguments: {
          to: ["recipient@example.test"],
          subject: "Forward",
          isForward: true,
          originalMessageId: "<private@example.test>",
        },
      })
    ).json();
    expect(response.result.isError).toBe(true);
    expect(listJobs(alice).items).toHaveLength(0);
  });
});
