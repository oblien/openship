// Run with Node so Socket.IO uses its supported Node HTTP/WebSocket transports.
const assert = require("node:assert/strict");
const { Agent: HttpAgent } = require("node:http");
const { Agent: HttpsAgent } = require("node:https");
const { createRequire } = require("node:module");
const { readFileSync, appendFileSync } = require("node:fs");
const { join } = require("node:path");
const [deps, out, protocol, host, port, phase, mode, expected] = process.argv.slice(2);
const { io } = createRequire(join(deps, "package.json"))("socket.io-client");
const MiB = 1024 * 1024;
const id = `${phase}-${mode}-${protocol}-${host}`;
const events = () =>
  readFileSync(join(out, "origin-events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
// Resolve only these two fixture hosts, locally, without modifying /etc/hosts or DNS.
const lookup = (hostname, options, callback) => {
  assert(["api.fixture.test", "events.fixture.test"].includes(hostname));
  callback(null, options.all ? [{ address: "127.0.0.1", family: 4 }] : "127.0.0.1", 4);
};
const agent = new (protocol === "http" ? HttpAgent : HttpsAgent)({
  lookup,
  rejectUnauthorized: false,
});
const client = io(`${protocol}://${host}:${port}`, {
  transports: mode === "upgrade" ? ["polling", "websocket"] : ["polling"],
  upgrade: mode === "upgrade",
  reconnection: false,
  timeout: 5000,
  forceNew: true,
  rejectUnauthorized: false,
  agent,
  extraHeaders: { "X-Forwarded-Proto": "https", "X-Fixture-Id": id },
  query: { proofId: id },
});
const once = (emitter, event, timeout = 8000) =>
  new Promise((done, fail) => {
    const timer = setTimeout(() => {
      emitter.off(event, receive);
      fail(new Error(`Timed out waiting for ${event}`));
    }, timeout);
    function receive(...values) {
      clearTimeout(timer);
      done(values);
    }
    emitter.once(event, receive);
  });
const record = (entry) => {
  appendFileSync(
    join(out, "socket.io.jsonl"),
    JSON.stringify({ phase, protocol, host, id, ...entry }) + "\n",
  );
  console.log(JSON.stringify(entry));
};
(async () => {
  try {
    await once(client, "connect");
    if (mode === "polling") {
      const ack = await client
        .timeout(5000)
        .emitWithAck("proof", { id: id + "-small", data: "hello" });
      assert.equal(ack.bytes, 5);
      const before = events().length;
      const beforeAccess = readFileSync(join(out, "access.log"), "utf8").length;
      let accepted = false;
      let rejection;
      try {
        const large = await client
          .timeout(3000)
          .emitWithAck("proof", { id: id + "-large", data: "x".repeat(1.5 * MiB) });
        accepted = large.bytes === 1.5 * MiB;
      } catch (error) {
        rejection = String(error);
      }
      const after = events().slice(before);
      const posts = after.filter(
        (event) => event.event === "http-start" && event.id === id && event.method === "POST",
      );
      const messages = after.filter(
        (event) => event.event === "socket-message" && event.id === id + "-large",
      );
      const expectedLarge = expected === "true";
      // A transport error alone is not proof of Edge rejection: require its 413.
      await new Promise((done) => setTimeout(done, 50));
      const edgePostStatuses = readFileSync(join(out, "access.log"), "utf8")
        .slice(beforeAccess)
        .split("\n")
        .filter((line) => line.includes(" POST /socket.io/") && line.includes(`id=${id}`))
        .map((line) => Number(line.match(/status=(\d+)/)?.[1]));
      record({
        mode: "socket.io-polling",
        smallAckBytes: ack.bytes,
        largePayloadBytes: 1.5 * MiB,
        accepted,
        expectedLarge,
        largeOriginPosts: posts.length,
        largeOriginMessages: messages.length,
        edgePostStatuses,
        rejection,
      });
      assert.equal(accepted, expectedLarge);
      assert.equal(messages.length, expectedLarge ? 1 : 0);
      assert.equal(posts.length, expectedLarge ? 1 : 0, "Rejected polling POST leaked to origin");
      assert(
        edgePostStatuses.includes(expectedLarge ? 200 : 413),
        "Missing expected Edge polling response",
      );
    } else {
      if (client.io.engine.transport.name !== "websocket") await once(client.io.engine, "upgrade");
      assert.equal(client.io.engine.transport.name, "websocket");
      const ack = await client
        .timeout(5000)
        .emitWithAck("proof", { id: id + "-1.5MiB", data: "x".repeat(1.5 * MiB) });
      assert.equal(ack.bytes, 1.5 * MiB);
      const disconnected = once(client, "disconnect");
      client.emit("proof", { id: id + "-over-app-limit", data: "x".repeat(2 * MiB + 1024) });
      const [reason] = await disconnected;
      const seen = events();
      assert(
        !seen.some(
          (event) => event.event === "socket-message" && event.id === id + "-over-app-limit",
        ),
      );
      assert(seen.some((event) => event.event === "upgrade" && event.url.includes(id)));
      record({
        mode: "socket.io-polling-to-websocket-upgrade",
        transport: "websocket",
        edgeBodyCap: host === "events.fixture.test" ? "1m" : "2m",
        acceptedMessageBytes: ack.bytes,
        rejectedMessageBytes: 2 * MiB + 1024,
        appMessageLimit: 2 * MiB,
        disconnectReason: reason,
        rejectedOriginMessages: 0,
      });
    }
  } finally {
    client.disconnect();
    agent.destroy();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
