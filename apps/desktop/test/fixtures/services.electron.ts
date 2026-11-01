import { app, net } from "electron";
import { strict as assert } from "node:assert";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  startLocalServices,
  stopLocalServicesAndWait,
  getLocalApiUrl,
  getLocalDashboardUrl,
} from "../../src/main/services";

const directory = process.argv.find((value) => value.startsWith("--fixture-dir="))?.slice(14);
assert.ok(directory);
assert.equal(
  process.versions.electron,
  process.argv.find((value) => value.startsWith("--expected-electron="))?.split("=")[1],
);
const profile = join(directory, "profile");
const resources = join(directory, "resources");
app.setPath("userData", profile);
Object.defineProperty(process, "resourcesPath", { value: resources });

void app.whenReady().then(async () => {
  try {
    await mkdir(profile, { recursive: true });
    const api = join(resources, "server");
    const dashboard = join(resources, "dashboard/apps/dashboard");
    for (const path of [api, dashboard]) {
      await mkdir(path, { recursive: true });
      await writeFile(join(path, "package.json"), '{"type":"module"}');
    }
    const script = `import { createServer } from 'node:http';
const server = createServer((request, response) => {
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ pid: process.pid, node: process.versions.node,
    host: server.address().address, data: process.env.PGLITE_DATA_DIR,
    auth: process.env.OPENSHIP_AUTH_MODE, api: process.env.OPENSHIP_LOCAL_API_URL }));
  if (request.url === '/reload') response.once('finish', () => process.exit(75));
});
server.listen(Number(process.env.PORT), '127.0.0.1');`;
    await writeFile(join(api, "index.js"), script);
    await writeFile(join(dashboard, "server.js"), script);
    await startLocalServices("fixture-only-token");
    const apiUrl = getLocalApiUrl();
    const dashboardUrl = getLocalDashboardUrl();
    const initial = await (await net.fetch(`${apiUrl}/api/health`)).json();
    const initialDashboard = await (await net.fetch(dashboardUrl)).json();
    assert.equal(initial.node, process.versions.node);
    assert.equal(initial.host, "127.0.0.1");
    assert.equal(initial.auth, "none");
    assert.equal(initial.data, join(profile, "data"));
    assert.equal(initialDashboard.api, apiUrl);
    const key = await readFile(join(profile, "auth-secret"), "utf8");
    await net.fetch(`${apiUrl}/reload`);
    const deadline = Date.now() + 10_000;
    let reloaded = initial;
    while (reloaded.pid === initial.pid && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      try {
        reloaded = await (await net.fetch(`${apiUrl}/api/health`)).json();
      } catch {
        /* The previous API has exited; its replacement is opening the same port. */
      }
    }
    assert.notEqual(
      reloaded.pid,
      initial.pid,
      "The API restarted through the production supervisor",
    );
    assert.equal(getLocalApiUrl(), apiUrl);
    assert.equal(reloaded.data, initial.data);
    assert.equal(await readFile(join(profile, "auth-secret"), "utf8"), key);
    assert.equal((await (await net.fetch(dashboardUrl)).json()).pid, initialDashboard.pid);
    await stopLocalServicesAndWait();
    await assert.rejects(net.fetch(`${apiUrl}/api/health`, { signal: AbortSignal.timeout(2000) }));
    console.log(`Electron service processes passed (${process.versions.electron})`);
    app.exit(0);
  } catch (error) {
    console.error(error);
    await stopLocalServicesAndWait();
    app.exit(1);
  }
});
