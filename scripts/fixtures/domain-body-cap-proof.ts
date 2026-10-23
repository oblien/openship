#!/usr/bin/env bun
/** Real, disposable OpenResty HTTP/TLS proof. See domain-body-cap/README.md. */
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createServer as tcpServer } from "node:net";
import { appendFileSync } from "node:fs";
import { mkdir, readFile, writeFile, readdir, copyFile, rm } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import {
  NginxProvider,
  readVhostGeneration,
  VHOST_GENERATION,
} from "../../packages/adapters/src/infra/nginx";
import { LocalExecutor } from "../../packages/adapters/src/system/local-executor";
import { rootChecked } from "../../packages/adapters/src/system/privilege";
import {
  buildReloadCommand,
  EDGE_CLIENT_MAX_BODY_SIZE,
  EDGE_SHARED_DICTS,
  OPENRESTY_DEFAULT_PATHS,
} from "../../packages/adapters/src/infra/openresty-lua";
import { resolveDomainProxySettings } from "../../packages/core/src/domain-proxy-settings";
import type { RouteConfig } from "../../packages/adapters/src/types";

const args = process.argv.slice(2);
const option = (key: string) => {
  const index = args.indexOf(key);
  return index < 0 ? undefined : args[index + 1];
};
assert(
  args.includes("--output") && args.includes("--socket-deps"),
  "Required: --output ABSOLUTE-NEW-DIRECTORY --socket-deps ABSOLUTE-DEPS-DIRECTORY",
);
const out = resolve(option("--output")!);
const deps = resolve(option("--socket-deps")!);
assert(out !== "/" && out !== process.cwd() && !deps.startsWith(out + "/"));
await mkdir(out, { recursive: true });
assert.equal((await readdir(out)).length, 0, "Refusing to overwrite an existing proof directory");
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runtime = join(out, "runtime");
const sites = join(runtime, "sites-enabled");
const native = args.includes("--native-nginx");
const servingSites = native ? join(runtime, "native-serving-sites") : sites;
let nativeOrigin: Bun.Subprocess | undefined;
let nativeNginx: Bun.Subprocess | undefined;
let originPort = 3000;
const certs = join(runtime, "certs");
const eventPath = join(out, "origin-events.jsonl");
const commandPath = join(out, "commands.log");
const configTestPath = join(out, "config-tests.log");
const container = `openship-cap-proof-${process.pid}-${randomBytes(4).toString("hex")}`;
const image =
  option("--image") ||
  "openresty/openresty@sha256:2f09322c11964de09cbc53c9dbda84ed299a9f777a5824a67a46c85260bcda92";
const nodeImage =
  option("--node-image") ||
  "node@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53";
const dockerConfig = join(runtime, "docker-config");
const hosts = ["api.fixture.test", "events.fixture.test"];
const MiB = 1024 * 1024;
const matrix: Record<string, unknown>[] = [];
const replayResults: Record<string, unknown>[] = [];
const protocols: ("http" | "https")[] = ["http", "https"];
let ownedContainer = false;
let extractionContainer: string | undefined;
let sequence = 0;
let successfulReloads = 0;
let inject: "invalid-config" | "reload-failure" | undefined;
let phase = "setup";
const negative = args.includes("--negative-control-project-only");
const result: Record<string, unknown> = {
  status: "RUNNING",
  engine: native ? "native-nginx-with-documented-lua-shims" : "openresty-container",
  image,
  nodeImage,
  negativeControl: negative,
  started: new Date().toISOString(),
  gaps: [
    "No API/DB/UI, deployment, whole-OS restart, ACME renewal, Linux bare-host ownership, or production proof",
    "Installed 50m default: rendered inheritance and 1.5 MiB smoke only, no 50 MiB boundary matrix",
    "Reload fault occurs before HUP delivery; no asynchronous master-failure recovery claim",
  ],
};
const log = (message: string) => {
  console.log(message);
  appendFileSync(join(out, "stdout.log"), message + "\n");
};
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
async function command(argv: string[], allowFailure = false) {
  appendFileSync(commandPath, "$ " + argv.map(quote).join(" ") + "\n");
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 120_000);
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timeout);
  appendFileSync(commandPath, stdout + stderr + `\n[exit ${code}]\n`);
  if (!allowFailure) assert.equal(code, 0, `${argv[0]} failed: ${stderr || stdout}`);
  return { stdout, stderr, code };
}
const docker = (...argv: string[]) => ["docker", "--config", dockerConfig, ...argv];
async function freePort() {
  const server = tcpServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((done, fail) => server.close((error) => (error ? fail(error) : done())));
  return port;
}
const events = async (): Promise<any[]> =>
  (await readFile(eventPath, "utf8").catch(() => ""))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
async function until<T>(
  read: () => Promise<T | undefined>,
  label: string,
  timeout = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await sleep(50);
  }
  throw new Error(`Timed out: ${label}`);
}
let ports: { http: number; https: number; management: number };
async function http(
  protocol: "http" | "https",
  host: string,
  path: string,
  bytes = 0,
  framing = "content-length",
  id = `request-${++sequence}`,
  extra: Record<string, string> = {},
) {
  return new Promise<{ status: number; body: string; headers: any; id: string }>((done, fail) => {
    const req = (protocol === "http" ? httpRequest : httpsRequest)(
      {
        hostname: "127.0.0.1",
        port: ports[protocol],
        servername: host,
        rejectUnauthorized: false,
        path,
        method: "POST",
        agent: false,
        headers: {
          Host: host,
          "X-Forwarded-Proto": "https",
          "X-Fixture-Id": id,
          ...(framing === "chunked"
            ? { "Transfer-Encoding": "chunked" }
            : { "Content-Length": String(bytes) }),
          ...extra,
        },
      },
      (res) => {
        const data: Buffer[] = [];
        res.on("data", (chunk) => data.push(chunk));
        res.on("end", () =>
          done({
            status: res.statusCode!,
            body: Buffer.concat(data).toString(),
            headers: res.headers,
            id,
          }),
        );
        res.on("error", fail);
      },
    );
    req.setTimeout(10_000, () => req.destroy(new Error("HTTP request timed out")));
    // nginx can close a rejected body while the client is still writing. Preserve its response.
    req.on("error", (error: any) => {
      if (error.code !== "EPIPE" && error.code !== "ECONNRESET") fail(error);
    });
    for (let offset = 0; offset < bytes; offset += 65536)
      req.write(Buffer.alloc(Math.min(65536, bytes - offset), 120));
    req.end();
  });
}
async function row(
  protocol: "http" | "https",
  host: string,
  bytes: number,
  framing: string,
  expected: number,
  label: string,
) {
  const id = `${phase}-${label}-${++sequence}`;
  const before = await events();
  const response = await http(protocol, host, `/count?case=${id}`, bytes, framing, id);
  const arrived = (await events()).slice(before.length).filter((event) => event.id === id);
  const starts = arrived.filter((event) => event.event === "http-start");
  const ends = arrived.filter((event) => event.event === "http-end");
  const originBytes = ends.reduce((sum, event) => sum + event.bytes, 0);
  const entry = {
    phase,
    protocol,
    host,
    label,
    framing,
    attemptedBytes: bytes,
    expected,
    status: response.status,
    originRequests: starts.length,
    originCompleted: ends.length,
    originBytes,
    id,
  };
  matrix.push(entry);
  await writeFile(join(out, "matrix.json"), JSON.stringify(matrix, null, 2) + "\n");
  assert.equal(response.status, expected, JSON.stringify(entry));
  assert.equal(
    starts.length,
    expected === 200 ? 1 : 0,
    `Edge rejection leaked to origin: ${JSON.stringify(entry)}`,
  );
  if (expected === 200) {
    assert.equal(originBytes, bytes);
    assert.equal(JSON.parse(response.body).bytes, bytes);
    assert.equal(JSON.parse(response.body).host, host);
  }
  return entry;
}
const paths = {
  bin: native ? "/opt/homebrew/bin/nginx" : "/usr/local/openresty/bin/openresty",
  compiledConfPath: join(runtime, "nginx.conf"),
  confPath: join(runtime, "nginx.conf"),
  confDir: runtime,
  sitesDir: sites,
  pidPath: join(runtime, "nginx.pid"),
};
async function syncNativeSites() {
  for (const name of await readdir(sites)) {
    if (!name.endsWith(".conf")) continue;
    const raw = await readFile(join(sites, name), "utf8");
    const served = raw
      .replace(/^    (?:log_by_lua_file|access_by_lua_file) [^;]+;\n/gm, "")
      .replace(/^    listen 80;/gm, `    listen 127.0.0.1:${ports.http};`)
      .replace(/^    listen 443 ssl;/gm, `    listen 127.0.0.1:${ports.https} ssl;`);
    assert.deepEqual(
      served.match(/client_max_body_size[^;]+;/g),
      raw.match(/client_max_body_size[^;]+;/g),
      "Harness changed a feature directive",
    );
    await writeFile(join(servingSites, name), served);
    appendFileSync(
      join(out, "native-shims.jsonl"),
      JSON.stringify({
        phase,
        file: name,
        rawSha256: hash(raw),
        servedSha256: hash(served),
        shims: ["remove access/log Lua hooks", "remap listeners to free loopback ports"],
      }) + "\n",
    );
  }
}
class FixtureExecutor extends LocalExecutor {
  override async exec(text: string): Promise<string> {
    // The provider inventories the container-side sites path. It is an alias
    // mount of this fixture's sites directory, never the host's real nginx tree.
    const inventoryDir = OPENRESTY_DEFAULT_PATHS.sitesDir;
    const generationPattern = `^# openship-vhost-gen: ${VHOST_GENERATION}$`;
    const listCommand = `ls -1 ${quote(inventoryDir)} 2>/dev/null || true`;
    const staleCommand = `grep -L ${quote(generationPattern)} ${quote(inventoryDir)}/*.conf 2>/dev/null || true`;
    if (text === listCommand || text === staleCommand) {
      appendFileSync(commandPath, `# Exact allowlisted adapter inventory command:\n${text}\n`);
      if (!native)
        return (await command(docker("exec", container, "sh", "-c", text))).stdout.trim();
      // Native mode has no container alias; map only these two read-only operations
      // onto the owned fixture directory. Config tests and reloads remain real.
      if (text === listCommand) return (await command(["ls", "-1", sites])).stdout.trim();
      const files = (await readdir(sites)).filter((name) => name.endsWith(".conf"));
      const stale = await command(
        ["grep", "-L", generationPattern, ...files.map((name) => join(sites, name))],
        true,
      );
      assert(stale.code === 0 || stale.code === 1, "Fixture stale-generation inventory failed");
      return stale.stdout.trim();
    }
    assert.equal(text, buildReloadCommand(paths), "Unexpected adapter command; refusing to run it");
    appendFileSync(
      commandPath,
      `# Adapter requested (executed inside owned container):\n${text}\n`,
    );
    const fault = inject;
    inject = undefined;
    if (fault === "invalid-config") {
      const file = join(sites, "events-fixture-test.conf");
      const candidate = (await readFile(file, "utf8")) + "\nfixture_invalid_directive;\n";
      await writeFile(file, candidate);
      await writeFile(join(out, "rollback-invalid-candidate.conf"), candidate);
    }
    if (native) await syncNativeSites();
    const tested = await command(
      native
        ? [paths.bin, "-t", "-c", paths.confPath]
        : docker("exec", container, paths.bin, "-t", "-c", paths.confPath),
      true,
    );
    appendFileSync(
      configTestPath,
      `# ${phase} fault=${fault || "none"}\n${tested.stdout}${tested.stderr}[exit ${tested.code}]\n`,
    );
    if (tested.code !== 0)
      throw new Error(`nginx config test rejected candidate: ${tested.stderr}`);
    const signal = fault === "reload-failure" ? "fixture-invalid-signal" : "reload";
    const reloaded = await command(
      native
        ? [paths.bin, "-s", signal, "-c", paths.confPath]
        : docker("exec", container, paths.bin, "-s", signal, "-c", paths.confPath),
      true,
    );
    if (reloaded.code !== 0) throw new Error(`nginx reload command failed: ${reloaded.stderr}`);
    successfulReloads++;
    // Wait for an observed response before a phase tests policy. Graceful reload is asynchronous.
    await sleep(150);
    return reloaded.stdout;
  }
}
let provider: NginxProvider;
function newProvider() {
  return new NginxProvider({
    paths,
    executor: rootChecked(new FixtureExecutor(), "fixture-only files and an owned proxy process"),
    certDir: certs,
    challengeDir: join(runtime, "challenge"),
    pinPaths: true,
    containerEdge: true,
  });
}
async function apply(project: unknown, overrides: unknown[], tls = true) {
  for (let index = 0; index < hosts.length; index++) {
    const route: RouteConfig = {
      domain: hosts[index]!,
      tls,
      targetUrl: `http://127.0.0.1:${originPort}`,
      proxy: resolveDomainProxySettings(project, negative ? null : overrides[index]),
    };
    await provider.registerRoute(route);
    const rendered = await readFile(
      join(sites, hosts[index]!.replaceAll(".", "-") + ".conf"),
      "utf8",
    );
    const desired = route.proxy?.clientMaxBodySize;
    assert.equal(
      (rendered.match(/^    client_max_body_size /gm) || []).length,
      desired ? (tls ? 2 : 1) : 0,
      "Exactly one cap per generated server scope",
    );
  }
  await snapshotPhase();
}
async function snapshotPhase() {
  const snapshot = join(out, "configs", phase);
  await mkdir(snapshot, { recursive: true });
  for (const name of await readdir(sites)) await copyFile(join(sites, name), join(snapshot, name));
  await copyFile(paths.confPath, join(snapshot, "nginx.conf"));
  if (native) {
    await mkdir(join(snapshot, "native-serving"));
    for (const name of await readdir(servingSites))
      await copyFile(join(servingSites, name), join(snapshot, "native-serving", name));
  }
}
async function readReplayState() {
  return Promise.all(
    hosts.map(async (domain, index) => {
      const slug = domain.replaceAll(".", "-");
      const conf = await readFile(join(sites, `${slug}.conf`), "utf8");
      const sidecar = await readFile(join(sites, `${slug}.route.json`), "utf8");
      // These are generated server starts, so splitting at their exact header does
      // not confuse nested location/if braces or HTML in an error handler.
      const servers = conf.split(/^server \{$/m).slice(1);
      assert.equal(servers.length, 2, `Expected HTTP and HTTPS serving blocks for ${domain}`);
      const scopes = servers.map((block) => {
        const listener = block.match(/^    listen ([^;]+);/m)?.[1];
        const caps = [...block.matchAll(/^    client_max_body_size ([^;]+);/gm)].map(
          (match) => match[1],
        );
        assert.deepEqual(caps, [index === 0 ? "2m" : "1m"], `Cap changed in ${domain} ${listener}`);
        return { listener, cap: caps[0] };
      });
      assert.deepEqual(
        scopes.map((scope) => scope.listener),
        ["80", "443 ssl"],
      );
      assert.equal(JSON.parse(sidecar).proxy.clientMaxBodySize, index === 0 ? "2m" : "1m");
      return {
        domain,
        generation: readVhostGeneration(conf),
        configSha256: hash(conf),
        sidecarSha256: hash(sidecar),
        scopes,
      };
    }),
  );
}
async function replayRequests() {
  const first = matrix.length;
  for (const protocol of protocols)
    for (const framing of ["content-length", "chunked"]) {
      await row(protocol, hosts[0]!, 1.5 * MiB, framing, 200, "replayed-2m-domain");
      await row(protocol, hosts[1]!, 1.5 * MiB, framing, 413, "replayed-1m-domain");
    }
  return matrix.slice(first);
}
async function lifecycleReplay() {
  for (const domain of hosts) {
    phase = `certificate-activation-${domain}`;
    const before = await readReplayState();
    const reloadsBefore = successfulReloads;
    await provider.activateCert(domain);
    assert.equal(
      successfulReloads - reloadsBefore,
      1,
      "Certificate activation did not validate and reload the real proxy",
    );
    const after = await readReplayState();
    assert.deepEqual(after, before, "Certificate activation changed stored caps or serving config");
    await snapshotPhase();
    replayResults.push({
      phase,
      operation: "activateCert",
      domain,
      successfulReloads: successfulReloads - reloadsBefore,
      before,
      after,
      requests: await replayRequests(),
    });
    await writeFile(
      join(out, "replay-results.json"),
      JSON.stringify(replayResults, null, 2) + "\n",
    );
  }

  phase = "stored-route-replay";
  const before = await readReplayState();
  const staleDir = join(out, "configs", "stored-route-replay-stale-input");
  await mkdir(staleDir, { recursive: true });
  for (const domain of hosts) {
    const name = domain.replaceAll(".", "-") + ".conf";
    const path = join(sites, name);
    const current = await readFile(path, "utf8");
    // Only remove generation comments to select the real repair branch. The
    // saved RouteConfigs and all serving directives stay untouched.
    const stale = current.replace(/^# openship-vhost-gen: \d+\n/gm, "");
    assert.notEqual(current, stale, "Generation-aging setup did not change the fixture comment");
    assert.equal(readVhostGeneration(stale), null);
    await writeFile(path, stale);
    await writeFile(join(staleDir, name), stale);
  }
  const reloadsBefore = successfulReloads;
  // Fresh provider state represents calling the startup replay routine; the
  // existing container/master/origin are intentionally kept running.
  provider = newProvider();
  const replayed = await provider.reapplyStoredRoutes();
  assert.equal(replayed.scanned, hosts.length);
  assert.deepEqual([...replayed.repaired].sort(), [...hosts].sort());
  assert.deepEqual(replayed.failed, []);
  assert.equal(
    successfulReloads - reloadsBefore,
    hosts.length,
    "Stored routes were not actually re-rendered, validated and reloaded",
  );
  const after = await readReplayState();
  assert.deepEqual(after, before, "Stored-route replay changed caps, sidecars or generated config");
  assert(after.every((state) => state.generation === VHOST_GENERATION));
  await snapshotPhase();
  replayResults.push({
    phase,
    operation: "reapplyStoredRoutes",
    freshProviderInstance: true,
    setup: "removed generation comments only",
    successfulReloads: successfulReloads - reloadsBefore,
    replayed,
    before,
    after,
    requests: await replayRequests(),
  });
  await writeFile(join(out, "replay-results.json"), JSON.stringify(replayResults, null, 2) + "\n");
  log(
    "PASS: real activateCert on each existing domain and fresh-provider stored-route replay preserved both HTTP/HTTPS caps and 1.5 MiB origin behavior",
  );
}
async function boundaries(caps: number[]) {
  for (const protocol of protocols)
    for (let index = 0; index < hosts.length; index++)
      for (const framing of ["content-length", "chunked"]) {
        for (const delta of [-1, 0, 1])
          await row(
            protocol,
            hosts[index]!,
            caps[index]! + delta,
            framing,
            delta > 0 ? 413 : 200,
            `cap${delta < 0 ? "-1" : delta > 0 ? "+1" : ""}`,
          );
        await row(
          protocol,
          hosts[index]!,
          1.5 * MiB,
          framing,
          caps[index]! >= 1.5 * MiB ? 200 : 413,
          "1.5MiB",
        );
      }
}
async function polling(protocol: "http" | "https", host: string, expectedLarge: boolean) {
  await command([
    "node",
    join(repo, "scripts/fixtures/domain-body-cap/socket-client.cjs"),
    deps,
    out,
    protocol,
    host,
    String(ports[protocol]),
    phase,
    "polling",
    String(expectedLarge),
  ]);
}
async function websocket(protocol: "http" | "https", host: string) {
  await command([
    "node",
    join(repo, "scripts/fixtures/domain-body-cap/socket-client.cjs"),
    deps,
    out,
    protocol,
    host,
    String(ports[protocol]),
    phase,
    "upgrade",
    "true",
  ]);
}
async function management(host: string, rules: unknown[]) {
  const response = await fetch(`http://127.0.0.1:${ports.management}/rules`, {
    method: "POST",
    body: JSON.stringify({ host, rules }),
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(response.status, 200, await response.text());
}
async function rate() {
  if (native) {
    log("GAP: production Lua rate behavior requires OpenResty; ordinary nginx cannot execute it");
    return;
  }
  // Unique prefixes prevent old per-second buckets from contaminating a later phase.
  for (const protocol of protocols)
    for (const host of hosts) {
      const prefix = `/rate-${phase}-${protocol}`;
      const rules = [
        { pathPrefix: prefix, spec: { rateLimit: { rps: 1, burst: 0, status: 429 } } },
        { pathPrefix: prefix + "/more", spec: { rateLimit: { rps: 3, burst: 0, status: 429 } } },
      ];
      await management(host, rules);
      const beforeConfig = hash(
        await readFile(join(sites, host.replaceAll(".", "-") + ".conf"), "utf8"),
      );
      // Start near the beginning of a one-second fixed window; retry only if the clock crosses it.
      let statuses: number[] = [],
        retryAfter: unknown;
      let originRequests = 0;
      for (let attempt = 0; attempt < 3; attempt++) {
        await sleep(1100 - (Date.now() % 1000));
        const start = Date.now();
        const before = (await events()).length;
        const responses = [];
        for (const suffix of ["", "", "/more", "/more", "/more", "/more"])
          responses.push(await http(protocol, host, prefix + suffix));
        if (Math.floor(start / 1000) !== Math.floor(Date.now() / 1000)) continue;
        statuses = responses.map((response) => response.status);
        retryAfter = responses[1]!.headers["retry-after"];
        originRequests = (await events())
          .slice(before)
          .filter((event) => event.event === "http-start" && event.url.startsWith(prefix)).length;
        break;
      }
      const entry = {
        phase,
        protocol,
        host,
        statuses,
        retryAfter,
        originRequests,
        expected: [200, 429, 200, 200, 200, 429],
        rules,
      };
      appendFileSync(join(out, "rate-limits.jsonl"), JSON.stringify(entry) + "\n");
      assert.deepEqual(statuses, entry.expected);
      assert.equal(retryAfter, "1");
      assert.equal(originRequests, 4);
      assert.equal(
        hash(await readFile(join(sites, host.replaceAll(".", "-") + ".conf"), "utf8")),
        beforeConfig,
        "Rate rule changed the vhost instead of being reload-free",
      );
      await management(host, []);
    }
}
async function rollback(fault: "invalid-config" | "reload-failure") {
  phase = `rollback-${fault}`;
  const conf = join(sites, "events-fixture-test.conf");
  const state = join(sites, "events-fixture-test.route.json");
  const beforeConf = await readFile(conf, "utf8");
  const beforeState = await readFile(state, "utf8");
  inject = fault;
  let error: unknown;
  try {
    await provider.registerRoute({
      domain: hosts[1]!,
      tls: true,
      targetUrl: `http://127.0.0.1:${originPort}`,
      proxy: resolveDomainProxySettings({ clientMaxBodySize: "2m" }, { clientMaxBodySize: "1m" }),
    });
  } catch (caught) {
    error = caught;
  }
  assert(error, "Expected adapter apply to reject the candidate");
  assert.equal(await readFile(conf, "utf8"), beforeConf);
  assert.equal(await readFile(state, "utf8"), beforeState);
  const evidence = {
    fault,
    error: String(error),
    previousConfigSha256: hash(beforeConf),
    restoredConfigSha256: hash(await readFile(conf, "utf8")),
    previousStateSha256: hash(beforeState),
    restoredStateSha256: hash(await readFile(state, "utf8")),
  };
  await writeFile(join(out, `rollback-${fault}.json`), JSON.stringify(evidence, null, 2) + "\n");
  for (const protocol of protocols) {
    await row(protocol, hosts[1]!, 1.5 * MiB, "content-length", 200, "old-cap-still-serving");
    await row(protocol, hosts[1]!, 2 * MiB + 1, "chunked", 413, "old-cap-still-enforced");
  }
}
async function cleanup() {
  for (const child of [nativeNginx, nativeOrigin]) {
    if (!child) continue;
    appendFileSync(commandPath, `# Stop owned foreground child PID ${child.pid} with SIGTERM\n`);
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
    await child.exited;
    clearTimeout(timer);
  }
  nativeNginx = undefined;
  nativeOrigin = undefined;
  if (ownedContainer) {
    await command(docker("logs", container), true);
    await command(docker("rm", "--force", container), true);
    ownedContainer = false;
  }
  if (extractionContainer) {
    await command(docker("rm", "--force", extractionContainer), true);
    extractionContainer = undefined;
  }
  await rm(join(runtime, "tools"), { recursive: true, force: true });
  // Keep public certificates + generated configs, never retain even fixture private keys.
  for (const host of hosts) await rm(join(certs, host, "privkey.pem"), { force: true });
  await rm(paths.pidPath, { force: true });
  result.cleanedUp = true;
}
let exiting = false;
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, async () => {
    if (exiting) return;
    exiting = true;
    result.status = "INTERRUPTED";
    await cleanup();
    await writeFile(join(out, "summary.json"), JSON.stringify(result, null, 2));
    process.exit(130);
  });
try {
  await mkdir(sites, { recursive: true });
  await mkdir(dockerConfig, { recursive: true });
  await mkdir(join(runtime, "tools"), { recursive: true });
  await writeFile(join(dockerConfig, "config.json"), "{}\n");
  await writeFile(eventPath, "");
  log(`Command: ${process.argv.map(quote).join(" ")}`);
  log(`Fixture root: ${out}`);
  result.sourceHead = (await command(["git", "-C", repo, "rev-parse", "HEAD"])).stdout.trim();
  const sources = [
    "packages/adapters/src/infra/nginx.ts",
    "packages/core/src/domain-proxy-settings.ts",
    "packages/core/src/proxy-settings.ts",
    "packages/adapters/src/infra/openresty-lua.ts",
    ...(await readdir(join(repo, "packages/adapters/src/infra/lua")))
      .filter((name) => name.endsWith(".lua"))
      .map((name) => `packages/adapters/src/infra/lua/${name}`),
    "scripts/fixtures/domain-body-cap-proof.ts",
    "scripts/fixtures/domain-body-cap/origin.ts",
    "scripts/fixtures/domain-body-cap/socket-client.cjs",
  ];
  await mkdir(join(out, "source-snapshot"));
  const sourceHashes: Record<string, string> = {};
  for (const source of sources) {
    const text = await readFile(join(repo, source), "utf8");
    sourceHashes[source] = hash(text);
    await writeFile(join(out, "source-snapshot", source.replaceAll("/", "__")), text);
  }
  result.sourceHashes = sourceHashes;
  await command(["bun", "--version"]);
  await command(["node", "--version"]);
  if (!native) {
    await command(["docker", "version", "--format", "{{.Server.Version}}"]);
    await command(docker("image", "inspect", image, "--format", "{{.Id}} {{json .RepoDigests}}"));
    await command(
      docker("image", "inspect", nodeImage, "--format", "{{.Id}} {{json .RepoDigests}}"),
    );
    extractionContainer = container + "-node";
    await command(
      docker("create", "--name", extractionContainer, "--entrypoint", "/bin/true", nodeImage),
    );
    await command(
      docker("cp", extractionContainer + ":/usr/local/bin/node", join(runtime, "tools", "node")),
    );
    for (const library of ["libstdc++.so.6", "libgcc_s.so.1"])
      await command(
        docker(
          "cp",
          "--follow-link",
          extractionContainer + ":/usr/lib/" + library,
          join(runtime, "tools", library),
        ),
      );
    await command(docker("rm", extractionContainer));
    extractionContainer = undefined;
  } else {
    (result.gaps as string[]).push(
      "Production Lua rate behavior not executed in native nginx mode; run the OpenResty mode for that separate behavior test",
    );
    await mkdir(servingSites, { recursive: true });
    await command([paths.bin, "-V"]);
    originPort = await freePort();
  }
  ports = { http: await freePort(), https: await freePort(), management: await freePort() };
  assert.equal(
    new Set(Object.values(ports)).size,
    3,
    "Port allocation raced; rerun with a fresh directory",
  );
  result.ports = ports;
  for (const host of hosts) {
    await mkdir(join(certs, host), { recursive: true, mode: 0o700 });
    await command([
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      `/CN=${host}`,
      "-addext",
      `subjectAltName=DNS:${host}`,
      "-keyout",
      join(certs, host, "privkey.pem"),
      "-out",
      join(certs, host, "fullchain.pem"),
    ]);
  }
  await copyFile(
    join(repo, "scripts/fixtures/domain-body-cap/origin.ts"),
    join(runtime, "origin.ts"),
  );
  let conf = `worker_processes 1;\nerror_log ${out}/error.log info;\npid ${paths.pidPath};\nevents { worker_connections 256; }\nhttp {\n  default_type application/octet-stream;\n  client_max_body_size ${EDGE_CLIENT_MAX_BODY_SIZE};\n  client_body_temp_path ${runtime}/body-temp;\n  proxy_temp_path ${runtime}/proxy-temp;\n  log_format fixture '$host $request_method $request_uri status=$status bytes=$request_length id=$http_x_fixture_id';\n  access_log ${out}/access.log fixture;\n  lua_package_path "/usr/local/openresty/site/lualib/?.lua;;";\n${EDGE_SHARED_DICTS.map(({ name, size }) => `  lua_shared_dict ${name} ${size};`).join("\n")}\n  include ${sites}/*.conf;\n  server { listen 9145; location / { content_by_lua_file /usr/local/openresty/site/lualib/openship/mgmt_api.lua; } }\n}\n`;
  if (native) {
    conf = conf
      .replace(/^  lua_package_path .*;\n/m, "")
      .replace(/^  lua_shared_dict .*;\n/gm, "")
      .replace(`include ${sites}/*.conf;`, `include ${servingSites}/*.conf;`)
      .replace(/^  server \{ listen 9145; .*\n/m, "");
  }
  await writeFile(paths.confPath, conf);
  if (native) {
    const nginxArgs = [paths.bin, "-c", paths.confPath, "-g", "daemon off;"];
    appendFileSync(commandPath, "$ " + nginxArgs.map(quote).join(" ") + "\n");
    nativeNginx = Bun.spawn(nginxArgs, {
      stdout: Bun.file(join(out, "nginx-process.stdout.log")),
      stderr: Bun.file(join(out, "nginx-process.stderr.log")),
    });
    const originArgs = ["node", join(runtime, "origin.ts"), String(originPort), eventPath, deps];
    appendFileSync(commandPath, "$ " + originArgs.map(quote).join(" ") + "\n");
    nativeOrigin = Bun.spawn(originArgs, {
      stdout: Bun.file(join(out, "origin-process.stdout.log")),
      stderr: Bun.file(join(out, "origin-process.stderr.log")),
    });
  } else {
    const launch = docker(
      "run",
      "--detach",
      "--name",
      container,
      "--publish",
      `127.0.0.1:${ports.http}:80`,
      "--publish",
      `127.0.0.1:${ports.https}:443`,
      "--publish",
      `127.0.0.1:${ports.management}:9145`,
      "--mount",
      `type=bind,src=${out},dst=${out}`,
      "--mount",
      `type=bind,src=${deps},dst=${deps},readonly`,
      "--mount",
      `type=bind,src=${sites},dst=${OPENRESTY_DEFAULT_PATHS.sitesDir}`,
      "--mount",
      `type=bind,src=${repo}/packages/adapters/src/infra/lua,dst=/usr/local/openresty/site/lualib/openship,readonly`,
      "--entrypoint",
      paths.bin,
      image,
      "-c",
      paths.confPath,
      "-g",
      "daemon off;",
    );
    ownedContainer = true;
    await command(launch);
    await command(docker("inspect", container, "--format", "{{json .HostConfig.PortBindings}}"));
    await command(docker("exec", container, paths.bin, "-V"));
    await command(
      docker(
        "exec",
        "--detach",
        container,
        "env",
        `LD_LIBRARY_PATH=${runtime}/tools`,
        join(runtime, "tools", "node"),
        join(runtime, "origin.ts"),
        "3000",
        eventPath,
        deps,
      ),
    );
  }
  await until(
    async () => ((await events()).some((event) => event.event === "ready") ? true : undefined),
    "counting origin ready",
  );
  provider = newProvider();

  phase = "baseline-project-2m";
  await apply({ clientMaxBodySize: "2m" }, [null, null]);
  await boundaries([2 * MiB, 2 * MiB]);
  for (const protocol of protocols) for (const host of hosts) await polling(protocol, host, true);
  await rate();
  log(
    "PASS: project-only 2m baseline, both hostnames, HTTP and HTTPS, CL + chunked boundaries, Socket.IO polling; rate evidence depends on engine mode",
  );

  phase = "domain-override-2m-1m";
  await apply({ clientMaxBodySize: "2m" }, [null, { clientMaxBodySize: "1m" }]);
  await boundaries([2 * MiB, MiB]);
  for (const protocol of protocols)
    for (const host of hosts) {
      await polling(protocol, host, host === hosts[0]);
      await websocket(protocol, host);
    }
  await rate();
  log(
    "PASS: independent 2m/1m caps, polling rejection before origin, real polling-to-WebSocket upgrade, app frame limit; rate evidence depends on engine mode",
  );
  await lifecycleReplay();

  phase = "project-change-3m-domain-still-1m";
  await apply({ clientMaxBodySize: "3m" }, [null, { clientMaxBodySize: "1m" }]);
  for (const protocol of protocols)
    for (const framing of ["content-length", "chunked"]) {
      await row(protocol, hosts[0]!, 2.5 * MiB, framing, 200, "inherited-new-project");
      await row(protocol, hosts[1]!, 1.5 * MiB, framing, 413, "override-preserved");
    }

  phase = "reset-to-project-2m";
  await apply({ clientMaxBodySize: "2m" }, [null, null]);
  await boundaries([2 * MiB, 2 * MiB]);
  await rollback("invalid-config");
  await rollback("reload-failure");
  log(
    "PASS: project edits affect inheriting domain only; reset restores inheritance; real config-test and reload-command failures restore serving config and sidecar",
  );

  phase = "installed-default-50m";
  await apply(undefined, [null, null]);
  for (const protocol of protocols)
    for (const host of hosts)
      await row(protocol, host, 1.5 * MiB, "content-length", 200, "unset-inherits-http-default");
  result.status = native ? "PARTIAL" : "PASS";
  result.assertionStatus = "PASS";
  result.requestRows = matrix.length;
  result.replayOperations = replayResults.length;
  result.replayRequestRows = replayResults.reduce(
    (sum, replay) => sum + (replay.requests as unknown[]).length,
    0,
  );
  result.originHttpRequests = (await events()).filter(
    (event) => event.event === "http-start",
  ).length;
  result.scope = `${native ? "Native nginx with documented Lua/port shims" : "Disposable OpenResty"} + real generated RouteConfig vhosts + shared resolver + actual activateCert and stored-route replay; no API/DB/UI, deployment, whole-OS restart, ACME renewal, or king-dev proof`;
} catch (error) {
  result.status = "FAIL";
  result.error = String(error);
  result.failedPhase = phase;
  log(`FAIL (${phase}): ${String(error)}`);
  process.exitCode = 1;
} finally {
  await cleanup();
  result.finished = new Date().toISOString();
  const originEvents = await events();
  const counters: Record<string, Record<string, number>> = {};
  for (const event of originEvents) {
    const key = event.id || event.host || "other";
    const count = (counters[key] ??= {});
    count[event.event] = (count[event.event] || 0) + 1;
    if (event.event === "http-end") count.bytes = (count.bytes || 0) + event.bytes;
  }
  await writeFile(join(out, "origin-counters.json"), JSON.stringify(counters, null, 2) + "\n");
  await writeFile(join(out, "summary.json"), JSON.stringify(result, null, 2) + "\n");
  if (matrix.length) {
    const keys = Object.keys(matrix[0]!);
    await writeFile(
      join(out, "matrix.csv"),
      keys.join(",") +
        "\n" +
        matrix.map((entry) => keys.map((key) => JSON.stringify(entry[key])).join(",")).join("\n") +
        "\n",
    );
  }
  log(`${result.status}: evidence at ${out}`);
}
