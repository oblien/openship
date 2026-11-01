/** Copied into the consumer directory by verify-package; every import resolves from the tarball. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WebSocketServer } from "ws";

const require = createRequire(import.meta.url);
const clients = [
  (await import("openship")).OpenshipClient,
  (await import("openship/client")).OpenshipClient,
  require("openship").OpenshipClient,
  require("openship/client").OpenshipClient,
];
const requests = [];
const sockets = new Set();
const server = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.url === "/control/api/health") {
      res.end(JSON.stringify({ sdk: { protocol: 1, fixedOrganizationScope: true } }));
      return;
    }
    if (req.url === "/control/api/health/env") {
      res.end(
        JSON.stringify({
          selfHosted: true,
          deployMode: "local",
          isServerHost: false,
          hostControlEnabled: false,
          version: "0.8.2",
          authMode: "local",
          productMode: "self-hosted",
          teamMode: "single_user",
          migrationTargetUrl: null,
          migrationInProgress: false,
          cloudAuthUrl: "https://app.openship.io",
          cloudApiUrl: "https://api.openship.io",
        }),
      );
      return;
    }
    assert.equal(req.headers.authorization, "Bearer opsh_pat_package_fixture");
    assert.equal(req.headers["x-organization-id"], "org_package");
    const payload = Buffer.concat(chunks).toString();
    requests.push({ path: req.url, body: payload ? JSON.parse(payload) : null });
    const path = new URL(req.url, "http://fixture").pathname;
    const result = path.endsWith("/ticket")
      ? { success: true, token: "package-ticket", expiresIn: 30 }
      : path.endsWith("/mail/servers")
        ? { servers: [] }
        : path.endsWith("/migration/sources")
          ? { sources: [] }
          : path.endsWith("/system/data-transfer/preview")
            ? { core: 0, history: {}, total: 0 }
            : path.endsWith("/projects")
              ? { data: [], total: 0, page: 1, perPage: 50 }
              : null;
    assert.ok(result, `Unexpected request: ${req.url}`);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(result));
  } catch (error) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: String(error) }));
  }
});
const ws = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  assert.equal(req.headers.origin, "https://dashboard.package.test");
  assert.equal(req.headers.authorization, undefined);
  assert.equal(req.headers["sec-websocket-protocol"], "openship.terminal.v1+package-ticket");
  assert.equal(req.url.includes("package-ticket"), false);
  ws.handleUpgrade(req, socket, head, (connection) => {
    sockets.add(connection);
    connection.once("close", () => sockets.delete(connection));
    connection.send(
      JSON.stringify({
        type: "ready",
        sessionId: "package-session",
        resumeToken: "package-resume",
        resumed: false,
      }),
    );
    connection.on("message", (data, binary) => {
      if (binary) {
        connection.send(data, { binary: true });
        connection.send(JSON.stringify({ type: "exit", code: 7 }));
      }
    });
  });
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
try {
  const baseUrl = `http://127.0.0.1:${server.address().port}/control`;
  for (const Client of clients) {
    const ship = new Client({
      baseUrl,
      token: "opsh_pat_package_fixture",
      organizationId: "org_package",
    });
    assert.deepEqual(await ship.mail.listServers(), []);
    assert.deepEqual(await ship.migrations.listSources(), []);
    assert.equal((await ship.instance.previewExport()).total, 0);
    for (const open of [ship.terminal.openServer, ship.terminal.openService]) {
      const received = [];
      const terminal = await open("fixture", {
        origin: "https://dashboard.package.test",
        onData: (bytes) => received.push(bytes),
      });
      terminal.write(new Uint8Array([0, 27, 255]));
      assert.equal((await terminal.closed).code, 7);
      assert.deepEqual(Buffer.concat(received), Buffer.from([0, 27, 255]));
    }
  }
  const state = join(process.cwd(), "remote-cli-state");
  await mkdir(state);
  await writeFile(
    join(state, "config.json"),
    JSON.stringify({
      current: "production",
      contexts: {
        production: {
          apiUrl: baseUrl,
          dashboardUrl: "https://dashboard.package.test",
          token: "opsh_pat_package_fixture",
          organizationId: "org_package",
        },
      },
    }),
    { mode: 0o600 },
  );
  const run = promisify(execFile);
  for (const args of [
    ["project", "list"],
    ["mail", "servers"],
    ["migration", "source", "list"],
  ]) {
    const result = await run(
      process.execPath,
      ["node_modules/openship/dist/node-entry.js", "--context", "production", "--json", ...args],
      {
        env: {
          ...process.env,
          OPENSHIP_HOME: state,
          OPENSHIP_TOKEN: "ambient-must-not-leak",
          OPENSHIP_API_URL: "http://127.0.0.1:1",
        },
        timeout: 30_000,
      },
    );
    assert.deepEqual(JSON.parse(result.stdout), []);
    assert.equal(result.stdout.includes("opsh_pat_"), false);
  }
  assert.ok(requests.length >= 23);
  console.log("PACKAGED_REMOTE_PLATFORM_OK");
} finally {
  for (const socket of sockets) socket.terminate();
  await new Promise((resolve) => ws.close(resolve));
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
