import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ImapFlow, type ImapFlowOptions } from "imapflow";
import { Hono } from "hono";

const scenario = process.argv[2];
if (scenario === "blank-hosts") {
  process.env.DEFAULT_IMAP_HOST = "   ";
  process.env.DEFAULT_SMTP_HOST = "";
}
const { authRoutes } = await import("../../src/routes/auth");
const { env } = await import("../../src/env");
const { db, schema } = await import("../../src/db");
const { getSession, saveSession, defaultMailHosts } = await import("../../src/lib/session");
const app = new Hono().route("/auth", authRoutes);

// Substitute only the remote IMAP connection. The HTTP validation, cookies,
// rate limits, session reuse, encryption and database writes are production code.
let failure: unknown;
let observed: ImapFlowOptions | undefined;
let probes = 0;
ImapFlow.prototype.connect = async function () {
  observed = (this as ImapFlow & { options: ImapFlowOptions }).options;
  probes++;
  if (failure) throw failure;
};
ImapFlow.prototype.logout = async () => {};
let requests = 0;
const signIn = (
  body: { email: string; password: string; name?: string } = {
    email: "user@example.test",
    password: "test-only-password",
  },
  cookie = "",
  ip?: string,
) =>
  app.request("/auth/sign-in", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      cookie,
      "X-Real-IP": ip ?? `192.0.2.${++requests}`,
    },
    body: JSON.stringify(body),
  });
const credentialError = () =>
  Object.assign(new Error("Command failed"), {
    authenticationFailed: true,
    responseStatus: "NO",
    serverResponseCode: "AUTHENTICATIONFAILED",
  });

if (scenario === "credentials") {
  failure = credentialError();
  const response = await signIn();
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, "Invalid email or password");
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal((await db.select().from(schema.session)).length, 0);
} else if (scenario === "unavailable") {
  const failures = [
    ...["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "ENETUNREACH", "CERT_HAS_EXPIRED"].map(
      (code) => ({ code }),
    ),
    { code: "NoConnection", authenticationFailed: true },
    { authenticationFailed: true, responseStatus: "NO", serverResponseCode: "UNAVAILABLE" },
    {
      authenticationFailed: true,
      responseStatus: "NO",
      responseText: "Temporary authentication failure",
    },
  ];
  for (const detail of failures) {
    failure = Object.assign(new Error("test-only-password"), {
      executedCommand: "test-only-password",
      ...detail,
    });
    const response = await signIn({
      email: `user${requests}@example.test`,
      password: "test-only-password",
    });
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.code, "MAIL_SERVER_UNAVAILABLE");
    assert.doesNotMatch(body.error, /invalid|password|test-only/i);
    assert.equal(response.headers.get("set-cookie"), null);
  }
  assert.equal((await db.select().from(schema.session)).length, 0);
  const audit = readFileSync(join(dirname(env.SQLITE_PATH), "auth.log"), "utf8");
  assert.doesNotMatch(audit, /test-only-password|invalid-credentials/);
} else if (scenario === "session-refresh" || scenario === "failed-reauth") {
  const first = await signIn({
    email: "user@example.test",
    password: "test-only-password",
    name: "Mailbox name",
  });
  assert.equal(first.status, 200);
  const { sessionId } = await first.json();
  const original = await getSession(sessionId);
  assert.equal(original?.password, "test-only-password");
  const other = await saveSession({
    email: "other@example.test",
    name: "Other",
    password: "other-test-password",
    imapHost: "other.example.test",
    imapPort: 993,
    smtpHost: "other.example.test",
    smtpPort: 465,
  });
  const cookie = `zero_sessions=${sessionId},${other.id}; zero_session=${sessionId}`;
  env.DEFAULT_IMAP_HOST = "new-mail.example.test";
  env.DEFAULT_SMTP_HOST = "new-smtp.example.test";
  env.DEFAULT_SMTP_PORT = 587;
  if (scenario === "failed-reauth")
    failure = Object.assign(new Error("Connection lost"), { code: "ECONNRESET" });
  const response = await signIn(
    { email: "USER@example.test", password: "updated-test-password" },
    cookie,
  );
  if (scenario === "failed-reauth") {
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("set-cookie"), null);
    assert.deepEqual(await getSession(sessionId), original);
  } else {
    assert.equal(response.status, 200);
    assert.equal((await response.json()).sessionId, sessionId);
    assert.equal(observed?.host, "new-mail.example.test");
    assert.equal(observed?.auth?.pass, "updated-test-password");
    const refreshed = await getSession(sessionId);
    assert.equal(refreshed?.name, "Mailbox name");
    assert.equal(refreshed?.password, "updated-test-password");
    assert.equal(refreshed?.imapHost, "new-mail.example.test");
    assert.equal(refreshed?.imapPort, 993);
    assert.equal(refreshed?.smtpHost, "new-smtp.example.test");
    assert.equal(refreshed?.smtpPort, 587);
    assert.equal((await db.select().from(schema.session)).length, 2);
  }
  assert.equal((await getSession(other.id))?.password, "other-test-password");
} else if (scenario === "blank-hosts") {
  assert.deepEqual(defaultMailHosts("user@example.test"), {
    imapHost: "mail.example.test",
    imapPort: 993,
    smtpHost: "mail.example.test",
    smtpPort: 465,
  });
} else if (scenario === "rate-limit") {
  failure = credentialError();
  for (let n = 0; n < 5; n++) assert.equal((await signIn(undefined, "", "192.0.2.55")).status, 401);
  const response = await signIn(undefined, "", "192.0.2.55");
  assert.equal(response.status, 429);
  assert.ok(response.headers.get("retry-after"));
  assert.equal(probes, 5);
} else {
  throw new Error(`Unknown auth scenario: ${scenario}`);
}
