/**
 * Whole-instance transfer through the real HTTP stack.
 *
 * This intentionally starts two API processes with separate PGlite databases
 * and encryption keys. It covers the boundaries a service-level test cannot:
 * body limits, public capability routes, bounded encrypted chunks, retry after
 * an accepted response is lost, SSE finalization, post-wipe runtime caches,
 * destination-key secret re-encryption, and file-upload resume after restart.
 */

import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";
import { readSseTerminalEvent } from "@repo/core";

import { openTransferSecrets } from "../../src/modules/system/data-transfer/passphrase-crypto";
import type {
  DataTransferFile,
  ImportResult,
  SecretBundle,
} from "../../src/modules/system/data-transfer/types";
import { TRANSFER_CHUNK_BYTES } from "../../src/modules/system/data-transfer/chunk-store";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const API_ENTRY = join(REPO_ROOT, "apps/api/src/index.ts");
const MAX_PROXY_BODY = TRANSFER_CHUNK_BYTES + 64;
const SECRET_VALUE = "transfer-secret-816-✓";
const FILE_SECRET_VALUE = "file-resume-secret-816-✓";
const FILE_PASSPHRASE = "issue-816-http-e2e-passphrase";

interface RunningApi {
  child: ChildProcessWithoutNullStreams;
  baseUrl: string;
  dbDir: string;
  port: number;
  secret: string;
  logs: () => string;
}

interface ProxyStats {
  requestBytes: number[];
  chunkAttempts: Map<string, number>;
  droppedAcceptedChunk: boolean;
  oversized: boolean;
}

let tempRoot: string | null = null;
const children = new Set<RunningApi>();
let proxy: Server | null = null;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a test port");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function waitForApi(api: RunningApi): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (api.child.exitCode !== null) {
      throw new Error(`API exited during startup (${api.child.exitCode})\n${api.logs()}`);
    }
    try {
      const response = await fetch(`${api.baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // Listener is not ready yet.
    }
    await delay(100);
  }
  throw new Error(`API did not become ready on ${api.baseUrl}\n${api.logs()}`);
}

async function startApi(input: {
  dbDir: string;
  port: number;
  secret: string;
}): Promise<RunningApi> {
  let output = "";
  const child = spawn("bun", [API_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      // Do not inherit Vitest's marker: @repo/db intentionally switches to an
      // in-memory PGlite under VITEST, which would make a process restart look
      // like data loss instead of reopening the explicit directory below.
      VITEST: "",
      NODE_ENV: "production",
      DEPLOY_MODE: "desktop",
      OPENSHIP_AUTH_MODE: "none",
      CLOUD_MODE: "false",
      DATABASE_URL: "",
      PGLITE_DATA_DIR: input.dbDir,
      BETTER_AUTH_SECRET: input.secret,
      INTERNAL_TOKEN: "issue-816-http-e2e-internal-token-000000000000",
      PORT: String(input.port),
      OPENSHIP_API_HOST: "127.0.0.1",
      OPENSHIP_ADVERTISED_ORIGIN: `http://127.0.0.1:${input.port}`,
      OPENSHIP_JOB_RUNNER: "in-process",
      OPENSHIP_CACHE_STORE: "memory",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const append = (chunk: Buffer | string) => {
    output = `${output}${chunk.toString()}`.slice(-50_000);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);

  const api: RunningApi = {
    child,
    baseUrl: `http://127.0.0.1:${input.port}`,
    dbDir: input.dbDir,
    port: input.port,
    secret: input.secret,
    logs: () => output,
  };
  children.add(api);
  await waitForApi(api);
  return api;
}

async function stopApi(api: RunningApi): Promise<void> {
  if (api.child.exitCode === null) {
    api.child.kill("SIGTERM");
    const exited = new Promise<boolean>((resolve) => api.child.once("exit", () => resolve(true)));
    if (!(await Promise.race([exited, delay(15_000).then(() => false)]))) {
      api.child.kill("SIGKILL");
      await new Promise<void>((resolve) => api.child.once("exit", () => resolve()));
    }
  }
  children.delete(api);
}

async function jsonRequest<T>(apiBase: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${init.method ?? "GET"} ${path} returned ${response.status}: ${text}`);
  }
  return JSON.parse(text) as T;
}

async function terminalSse<T>(apiBase: string, path: string, body: unknown): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    method: "POST",
    headers: { accept: "text/event-stream", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok || !response.body) {
    throw new Error(`${path} returned ${response.status}: ${await response.text()}`);
  }
  const terminal = await readSseTerminalEvent(response.body);
  if (terminal.event !== "complete") {
    throw new Error(`${path} ended with ${terminal.event}: ${terminal.data}`);
  }
  return JSON.parse(terminal.data) as T;
}

async function createProject(
  apiBase: string,
  name: string,
  slug: string,
  routingConfig?: Record<string, unknown>,
): Promise<{ id: string }> {
  const response = await jsonRequest<{ data: { id: string } }>(apiBase, "/api/projects", {
    method: "POST",
    body: JSON.stringify({
      name,
      slug,
      gitProvider: "github",
      gitOwner: "example",
      gitRepo: slug,
      gitBranch: "main",
      framework: "static",
      packageManager: "npm",
      productionMode: "static",
      port: 3000,
      hasServer: false,
      hasBuild: false,
      sourceKind: "git",
      buildKind: "static",
      workloadType: "static",
      routingConfig,
    }),
  });
  return response.data;
}

async function mergeEnv(
  apiBase: string,
  projectId: string,
  upserts: Array<{ key: string; value: string; isSecret: boolean }>,
): Promise<void> {
  await jsonRequest(apiBase, `/api/projects/${projectId}/env`, {
    method: "PATCH",
    body: JSON.stringify({ environment: "production", upserts, deletes: [] }),
  });
}

function findSecret(bundle: SecretBundle | null, value: string): boolean {
  return !!bundle?.entries.some((entry) => entry.value === value);
}

async function startRetryProxy(destinationPort: number): Promise<{
  baseUrl: string;
  stats: ProxyStats;
}> {
  const stats: ProxyStats = {
    requestBytes: [],
    chunkAttempts: new Map(),
    droppedAcceptedChunk: false,
    oversized: false,
  };

  proxy = createServer((incoming, outgoing) => {
    const path = incoming.url ?? "/";
    const chunkPath = /^\/api\/system\/data-transfer\/direct\/chunk\/[^/]+\/(\d+)$/.exec(path);
    if (chunkPath) {
      stats.chunkAttempts.set(chunkPath[1]!, (stats.chunkAttempts.get(chunkPath[1]!) ?? 0) + 1);
    }

    const headers = { ...incoming.headers, host: `127.0.0.1:${destinationPort}` };
    delete headers.connection;
    delete headers["transfer-encoding"];
    const upstream = httpRequest(
      {
        host: "127.0.0.1",
        port: destinationPort,
        method: incoming.method,
        path,
        headers,
      },
      (upstreamResponse) => {
        const dropThisResponse =
          !!chunkPath && !stats.droppedAcceptedChunk && (upstreamResponse.statusCode ?? 500) < 300;
        if (dropThisResponse) {
          stats.droppedAcceptedChunk = true;
          upstreamResponse.resume();
          upstreamResponse.once("end", () => outgoing.destroy());
          return;
        }
        // Node owns framing on this hop. Forwarding the upstream hop-by-hop
        // transfer-encoding header makes Bun correctly reject a doubly-framed
        // streamed response as UnsupportedTransferEncoding.
        const responseHeaders = { ...upstreamResponse.headers };
        delete responseHeaders.connection;
        delete responseHeaders["transfer-encoding"];
        delete responseHeaders["content-length"];
        outgoing.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
        upstreamResponse.pipe(outgoing);
      },
    );

    let bytes = 0;
    let rejected = false;
    incoming.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > MAX_PROXY_BODY && !rejected) {
        rejected = true;
        stats.oversized = true;
        upstream.destroy();
        outgoing.writeHead(413).end();
        return;
      }
      if (!rejected) upstream.write(chunk);
    });
    incoming.on("end", () => {
      stats.requestBytes.push(bytes);
      if (!rejected) upstream.end();
    });
    incoming.on("error", (error) => upstream.destroy(error));
    upstream.on("error", (error) => {
      if (!outgoing.destroyed) outgoing.destroy(error);
    });
  });

  await new Promise<void>((resolve, reject) => {
    proxy!.once("error", reject);
    proxy!.listen(0, "127.0.0.1", resolve);
  });
  const address = proxy.address();
  if (!address || typeof address === "string") throw new Error("Proxy did not bind a TCP port");
  return { baseUrl: `http://127.0.0.1:${address.port}`, stats };
}

afterAll(async () => {
  if (proxy) {
    await new Promise<void>((resolve) => proxy!.close(() => resolve()));
    proxy = null;
  }
  for (const child of [...children]) await stopApi(child);
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
});

it("transfers multiple HTTP chunks atomically and resumes a file import after restart", async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "openship-data-transfer-http-e2e-"));
  const sourcePort = await freePort();
  let destinationPort = await freePort();
  while (destinationPort === sourcePort) destinationPort = await freePort();

  const source = await startApi({
    dbDir: join(tempRoot, "source"),
    port: sourcePort,
    secret: "source-http-e2e-secret-816-00000000000000000",
  });
  let destination = await startApi({
    dbDir: join(tempRoot, "destination"),
    port: destinationPort,
    secret: "destination-http-e2e-secret-816-0000000000000",
  });

  // Warm the destination's process-local synthetic-user cache. A wipe replaces
  // this user; the next request is the regression that used to return 500.
  const initiallyEmpty = await jsonRequest<{ data: unknown[] }>(
    destination.baseUrl,
    "/api/projects?perPage=100",
  );
  expect(initiallyEmpty.data).toEqual([]);

  // One durable JSON column makes the payload cross the 8 MB boundary without
  // creating hundreds of encrypted rows (which would make this transport test
  // spend most of its time benchmarking per-row secret re-encryption).
  const largeRoutingConfig = {
    headers: Array.from({ length: 200 }, (_, group) => ({
      source: `/fixture-${group}`,
      headers: Array.from({ length: 11 }, (_, header) => ({
        key: `x-e2e-${group}-${header}`,
        value: `header-${group}-${header}-`.padEnd(3_900, String((group + header) % 10)),
      })),
    })),
  };
  const project = await createProject(
    source.baseUrl,
    "Transfer E2E Sentinel",
    "transfer-e2e-sentinel",
    largeRoutingConfig,
  );
  await mergeEnv(source.baseUrl, project.id, [
    { key: "E2E_SECRET", value: SECRET_VALUE, isSecret: true },
  ]);

  const retryProxy = await startRetryProxy(destination.port);
  const receive = await jsonRequest<{ code: string }>(
    destination.baseUrl,
    "/api/system/data-transfer/direct/session",
    {
      method: "POST",
      body: JSON.stringify({ apiBase: `${retryProxy.baseUrl}/api/`, mode: "wipe" }),
    },
  );
  const transferred = await terminalSse<ImportResult & { destination: string }>(
    source.baseUrl,
    "/api/system/data-transfer/direct/send/stream",
    { code: receive.code, selection: { history: [] } },
  );
  expect(transferred.mode).toBe("wipe");
  expect(transferred.secretsRehydrated).toBeGreaterThan(0);
  expect(retryProxy.stats.droppedAcceptedChunk).toBe(true);
  expect(retryProxy.stats.chunkAttempts.size).toBeGreaterThan(1);
  expect([...retryProxy.stats.chunkAttempts.values()].some((attempts) => attempts > 1)).toBe(true);
  expect(retryProxy.stats.oversized).toBe(false);
  expect(Math.max(...retryProxy.stats.requestBytes)).toBeLessThanOrEqual(MAX_PROXY_BODY);

  // No restart here: this proves the post-commit process cache is coherent.
  const destinationProjects = await jsonRequest<{ data: Array<{ id: string; slug: string }> }>(
    destination.baseUrl,
    "/api/projects?perPage=100",
  );
  expect(destinationProjects.data).toContainEqual(
    expect.objectContaining({ id: project.id, slug: "transfer-e2e-sentinel" }),
  );
  const masked = await jsonRequest<{
    data: Array<{ key: string; value: string; isSecret: boolean }>;
  }>(destination.baseUrl, `/api/projects/${project.id}/env`);
  expect(masked.data).toContainEqual(
    expect.objectContaining({ key: "E2E_SECRET", value: "••••••••", isSecret: true }),
  );

  const destinationExport = await jsonRequest<DataTransferFile>(
    destination.baseUrl,
    "/api/system/data-transfer/export",
    {
      method: "POST",
      body: JSON.stringify({ passphrase: FILE_PASSPHRASE, selection: { history: [] } }),
    },
  );
  expect(
    findSecret(openTransferSecrets(destinationExport.secrets, FILE_PASSPHRASE), SECRET_VALUE),
  ).toBe(true);

  // File upload uses the same import boundary. Upload one chunk, restart the
  // destination process against the same DB, then resume and finalize.
  const fileProject = await createProject(
    source.baseUrl,
    "File Resume Sentinel",
    "file-resume-sentinel",
  );
  await mergeEnv(source.baseUrl, fileProject.id, [
    { key: "FILE_RESUME_SECRET", value: FILE_SECRET_VALUE, isSecret: true },
  ]);
  const transferFile = await jsonRequest<DataTransferFile>(
    source.baseUrl,
    "/api/system/data-transfer/export",
    {
      method: "POST",
      body: JSON.stringify({ passphrase: FILE_PASSPHRASE, selection: { history: [] } }),
    },
  );
  const fileBytes = Buffer.from(JSON.stringify(transferFile), "utf8");
  expect(fileBytes.byteLength).toBeGreaterThan(TRANSFER_CHUNK_BYTES);
  const upload = await jsonRequest<{
    uploadId: string;
    chunkSize: number;
    totalChunks: number;
  }>(destination.baseUrl, "/api/system/data-transfer/import/session", {
    method: "POST",
    body: JSON.stringify({ size: fileBytes.byteLength }),
  });
  expect(upload.chunkSize).toBe(TRANSFER_CHUNK_BYTES);
  expect(upload.totalChunks).toBeGreaterThan(1);

  const uploadChunk = async (index: number): Promise<void> => {
    const chunk = fileBytes.subarray(index * upload.chunkSize, (index + 1) * upload.chunkSize);
    const response = await fetch(
      `${destination.baseUrl}/api/system/data-transfer/import/session/${upload.uploadId}/chunk/${index}`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          "x-openship-chunk-sha256": createHash("sha256").update(chunk).digest("hex"),
        },
        body: chunk,
      },
    );
    if (!response.ok)
      throw new Error(`file chunk ${index} returned ${response.status}: ${await response.text()}`);
  };

  await uploadChunk(0);
  await stopApi(destination);
  destination = await startApi({
    dbDir: destination.dbDir,
    port: destination.port,
    secret: destination.secret,
  });
  for (let index = 1; index < upload.totalChunks; index += 1) await uploadChunk(index);

  const imported = await terminalSse<ImportResult>(
    destination.baseUrl,
    `/api/system/data-transfer/import/session/${upload.uploadId}/finalize/stream`,
    { passphrase: FILE_PASSPHRASE, mode: "wipe" },
  );
  expect(imported.mode).toBe("wipe");
  expect(imported.secretsRehydrated).toBeGreaterThan(0);

  const afterResume = await jsonRequest<{ data: Array<{ id: string; slug: string }> }>(
    destination.baseUrl,
    "/api/projects?perPage=100",
  );
  expect(afterResume.data).toContainEqual(
    expect.objectContaining({ id: fileProject.id, slug: "file-resume-sentinel" }),
  );
  const finalExport = await jsonRequest<DataTransferFile>(
    destination.baseUrl,
    "/api/system/data-transfer/export",
    {
      method: "POST",
      body: JSON.stringify({ passphrase: FILE_PASSPHRASE, selection: { history: [] } }),
    },
  );
  expect(
    findSecret(openTransferSecrets(finalExport.secrets, FILE_PASSPHRASE), FILE_SECRET_VALUE),
  ).toBe(true);
}, 300_000);
