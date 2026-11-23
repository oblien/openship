/** Run explicitly against dev/compose.yml: bun dev:email:sample check. */
import assert from "node:assert/strict";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import type { AppRouter } from "../src/trpc";
import { env } from "../src/env";

assert.equal(env.SQLITE_PATH, "/sample/mail.db", "Run this check only in the sample API container");
assert.equal(env.NODE_ENV, "development");
const base = "http://127.0.0.1:3030";
async function login(user: string) {
  const response = await fetch(`${base}/auth/sign-in`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: base },
    body: JSON.stringify({ email: `${user}@openship.test`, password: "sample-mail" }),
  });
  assert.equal(response.status, 200, `Sign-in failed for ${user}`);
  // Sign-in first expires legacy cookies, then sets the current ones. Apply in
  // response order as a browser does instead of sending duplicate cookie names.
  const cookies = new Map<string, string>();
  for (const value of response.headers.getSetCookie()) {
    const pair = value.split(";")[0]!;
    const separator = pair.indexOf("=");
    cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
  const cookie = [...cookies]
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}=${value}`)
    .join("; ");
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${base}/api/trpc`,
        transformer: superjson,
        headers: { Cookie: cookie, Origin: base },
      }),
    ],
  });
}
const alex = await login("alex");
const sam = await login("sam");
const checkId = crypto.randomUUID();
const subject = `Cycle check ${checkId}`;
const q = `subject:${checkId}`;
const initial = await alex.mail.listThreads.query({ folder: "inbox", limit: 20 });
assert(initial.threads.length >= 6, "Expected seeded messages in the real inbox");

const draft = await alex.drafts.create.mutate({
  to: ["sam@openship.test"],
  subject,
  message: "<p>Draft round trip</p>",
});
assert.equal((await alex.drafts.get.query({ id: draft.id }))?.subject, subject);
await alex.drafts.delete.mutate({ id: draft.id });

const cancelled = await alex.mail.send.mutate({
  to: ["sam@openship.test"],
  subject: `${subject} cancelled`,
  text: "This must never arrive",
  scheduleAt: new Date(Date.now() + 60_000).toISOString(),
});
await alex.mail.unsend.mutate({ messageId: cancelled.messageId });
assert.equal((await alex.outbox.get.query({ id: cancelled.messageId })).state, "cancelled");
await assert.rejects(sam.outbox.get.query({ id: cancelled.messageId }));

const scheduled = await alex.mail.send.mutate({
  to: ["sam@openship.test"],
  subject,
  text: "Sent through the real queue and SMTP",
  attachments: [
    {
      name: "cycle.txt",
      type: "text/plain",
      base64: Buffer.from("attachment round trip").toString("base64"),
    },
  ],
  scheduleAt: new Date(Date.now() + 2500).toISOString(),
  requestId: crypto.randomUUID(),
});
const deadline = Date.now() + 30_000;
while ((await alex.outbox.get.query({ id: scheduled.messageId })).state !== "done") {
  assert(Date.now() < deadline, "The scheduled message did not finish sending");
  await Bun.sleep(500);
}
const received = await sam.mail.listThreads.query({ folder: "inbox", q, limit: 20 });
assert.equal(received.threads.length, 1, "The recipient should receive exactly one message");
const message = await sam.mail.get.query({ id: received.threads[0]!.id, folder: "inbox" });
assert.equal(message?.latest.attachments[0]?.filename, "cycle.txt");
assert.equal(
  (await alex.mail.listThreads.query({ folder: "sent", q, limit: 20 })).threads.length,
  1,
);
await sam.mail.snoozeThreads.mutate({
  ids: [received.threads[0]!.id],
  until: new Date(Date.now() + 2500).toISOString(),
});
assert.equal((await sam.mail.listThreads.query({ folder: "snoozed", q })).threads.length, 1);
const wakeDeadline = Date.now() + 15_000;
while (!(await sam.mail.listThreads.query({ folder: "inbox", q })).threads.length) {
  assert(Date.now() < wakeDeadline, "The snoozed message did not return to the inbox");
  await Bun.sleep(500);
}

const grant = await alex.mailAgents.create.mutate({
  name: "Cycle check",
  scopes: ["mail:read"],
  expiresInDays: 1,
});
const mcp = (token: string) =>
  fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
assert.equal((await mcp(grant.token)).status, 200);
await alex.mailAgents.revoke.mutate({ id: grant.id });
assert.equal((await mcp(grant.token)).status, 401);

console.log(
  "PASS: real sign-in, seeded inbox, draft save/read/delete, schedule, cancellation, SMTP delivery, Sent copy, attachment, snooze/wake-up, mailbox isolation, MCP access and revocation.",
);
