const test = require("node:test");
const assert = require("node:assert/strict");
const { mailboxAddress, webOrigin, resolveConnection } = require("../connections.cjs");

test("hosted discovery shares only the normalized domain and accepts a secure webmail origin", async () => {
  const connection = await resolveConnection(
    { mode: "cloud", email: "Alice@Bücher.test" },
    {
      cloud: "https://cloud.test",
      request: async (url, options) => {
        assert.equal(url.href, "https://cloud.test/api/mail/discovery?domain=xn--bcher-kva.test");
        assert.equal(options.credentials, "omit");
        assert.equal(options.redirect, "error");
        return Response.json({ webmailUrl: "https://webmail.host.test/" });
      },
    },
  );
  assert.equal(connection.email, "Alice@xn--bcher-kva.test");
  assert.equal(connection.origin, "https://webmail.host.test");
  for (const value of ["mailbox", "a@host.test:80", "a@host.test/path", "a@127.0.0.1"]) {
    assert.throws(() => mailboxAddress(value));
  }
});
test("self-hosted setup connects directly and restricts plain HTTP to local development", async () => {
  const input = { mode: "self", email: "a@host.test", url: "https://mail.host.test:8443" };
  assert.equal((await resolveConnection(input, {})).origin, input.url);
  for (const value of [
    "file:///tmp/mail",
    "http://host.test",
    "https://a:b@host.test",
    "https://host.test/login",
  ]) {
    assert.throws(() => webOrigin(value, true));
  }
  assert.throws(() => webOrigin("http://127.0.0.1:3040"));
  assert.equal(webOrigin("http://127.0.0.1:3040", true), "http://127.0.0.1:3040");
});
test("missing hosting, outage, and malformed Cloud replies produce actionable errors", async () => {
  for (const [response, message] of [
    [new Response(null, { status: 404 }), /No hosted inbox/],
    [new Response(null, { status: 503 }), /temporarily unavailable/],
    [Response.json({ webmailUrl: "http://untrusted.test" }), /invalid webmail/],
  ]) {
    await assert.rejects(
      resolveConnection(
        { mode: "cloud", email: "a@host.test" },
        { cloud: "https://cloud.test", request: async () => response },
      ),
      message,
    );
  }
});
