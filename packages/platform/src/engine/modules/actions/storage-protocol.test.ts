import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:https";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { generateId, AppError } from "@repo/core";
import { resolveDestination, type BackupDestination } from "@repo/adapters";
import {
  createDatabase,
  createRepositories,
  schema,
  eq,
  type DatabaseConnection,
} from "@repo/db/factory";
import type { ActionJob, ActionRun } from "@repo/db";
import { ActionRuntimeTokens, type ActionRuntimeIdentity } from "./runtime-identity";
import { ActionStorageProtocol } from "./storage-protocol";

const exec = promisify(execFile);
let connection: DatabaseConnection, root: string, server: Server, origin: string;
let repositories: ReturnType<typeof createRepositories>, protocol: ActionStorageProtocol;
const contexts = new Map<string, { run: ActionRun; job: ActionJob }>();
const stores = new Map<string, BackupDestination>();
const tokens = new ActionRuntimeTokens("isolated-actions-protocol-test-secret");
const report = vi.fn();
const errors: string[] = [];
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "openship-actions-storage-"));
  connection = await createDatabase({ driver: "pglite", dataDir: "memory://" });
  repositories = createRepositories(connection.db, { encrypt: (v) => v, decrypt: (v) => v });
  protocol = new ActionStorageProtocol({
    repo: repositories.actionStorage,
    tokens,
    baseUrl: () => `${origin}/api/actions/runtime/`,
    async authorize(identity) {
      const value = contexts.get(identity.jobId);
      if (
        !value ||
        value.run.id !== identity.runId ||
        value.run.organizationId !== identity.organizationId
      )
        throw new AppError("Forbidden", 403, "TEST_SCOPE");
      return { ...value, identity };
    },
    async store(org, id) {
      const found = stores.get(`${org}:${id}`);
      if (!found) throw new AppError("Forbidden destination", 403, "TEST_SCOPE");
      return found;
    },
    reportError: report,
  });
  const cert = join(root, "cert.pem"),
    key = join(root, "key.pem");
  await exec("openssl", [
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
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
    "-keyout",
    key,
    "-out",
    cert,
  ]);
  server = createServer(
    { key: await readFile(key), cert: await readFile(cert) },
    async (incoming, outgoing) => {
      try {
        const headers = new Headers();
        for (const [key, value] of Object.entries(incoming.headers))
          if (value) headers.set(key, Array.isArray(value) ? value.join(",") : value);
        const request = new Request(`${origin}${incoming.url}`, {
          method: incoming.method,
          headers,
          ...(!["GET", "HEAD"].includes(incoming.method!)
            ? { body: Readable.toWeb(incoming) as ReadableStream<Uint8Array>, duplex: "half" }
            : {}),
        });
        const response = await protocol.handle(request);
        outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
        if (response.body) Readable.fromWeb(response.body as never).pipe(outgoing);
        else outgoing.end();
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
        const status = error instanceof AppError ? error.statusCode : 500;
        outgoing.writeHead(status, { "content-type": "application/json" });
        outgoing.end(JSON.stringify({ code: "internal", msg: errors.at(-1) }));
      }
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
}, 60_000);
afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await connection?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const org = generateId("org"),
    destinationId = generateId("dest");
  await connection.db.insert(schema.organization).values({ id: org, name: org });
  const row = (
    await connection.db
      .insert(schema.backupDestination)
      .values({
        id: destinationId,
        organizationId: org,
        name: org,
        kind: "local",
        endpoint: join(root, org),
      })
      .returning()
  )[0]!;
  stores.set(`${org}:${destinationId}`, resolveDestination({ ...row, kind: "local" }));
  const authority = {
    version: 1 as const,
    userId: "test",
    organizationId: org,
    token: null,
    restrictions: null,
  };
  const plan = { name: "test", triggers: {}, jobs: [] };
  const workflow = await repositories.actions.saveWorkflow({
    id: generateId("wf"),
    organizationId: org,
    name: "test",
    owner: "acme",
    repo: "app",
    path: ".github/workflows/test.yml",
    ref: "main",
    source: "",
    definition: plan,
    runnerIds: [],
    authority,
    storageDestinationId: destinationId,
  });
  const run = await repositories.actions.createRun({
    id: generateId("run"),
    organizationId: org,
    workflowId: workflow.id,
    idempotencyKey: "one",
    source: "",
    plan,
    configuration: {
      owner: "acme",
      repo: "app",
      path: workflow.path,
      defaultBranch: "main",
      runnerIds: [],
      variables: {},
      secrets: {},
      storageDestinationId: destinationId,
    },
    authority,
    revision: "a".repeat(40),
    ref: "refs/heads/main",
    eventName: "push",
    event: {},
    actor: "test",
  });
  const jobs = await connection.db
    .insert(schema.actionJob)
    .values(
      [0, 1].map((index) => ({
        id: generateId("job"),
        organizationId: org,
        runId: run.id,
        jobKey: String(index),
        matrixIndex: 0,
        status: "running" as const,
        workerStartedAt: new Date(),
      })),
    )
    .returning();
  const issue = (
    job: ActionJob,
    purpose: ActionRuntimeIdentity["purpose"] = "runtime",
    objectId?: number,
  ) => tokens.issue({ purpose, organizationId: org, runId: run.id, jobId: job.id, objectId }, 600);
  jobs.forEach((job) => contexts.set(job.id, { run, job }));
  return { org, run, jobs, issue, destinationId };
}

async function officialClient(
  mode: string,
  fixtureValue: Awaited<ReturnType<typeof fixture>>,
  v2 = true,
) {
  const workspace = await mkdtemp(join(root, "workspace-"));
  const before = errors.length;
  const output = await exec(
    process.execPath,
    [
      fileURLToPath(
        new URL("../../../../test/fixtures/actions-storage-client.cjs", import.meta.url),
      ),
      mode,
    ],
    {
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        NODE_EXTRA_CA_CERTS: join(root, "cert.pem"),
        ACTIONS_RUNTIME_TOKEN: await fixtureValue.issue(fixtureValue.jobs[0]!),
        NEXT_JOB_TOKEN: await fixtureValue.issue(fixtureValue.jobs[1]!),
        ACTIONS_RUNTIME_URL: `${origin}/api/actions/runtime/`,
        ACTIONS_RESULTS_URL: `${origin}/api/actions/runtime/`,
        ACTIONS_CACHE_URL: `${origin}/api/actions/runtime/`,
        ACTIONS_CACHE_SERVICE_V2: v2 ? "true" : "",
        GITHUB_WORKSPACE: workspace,
        RUNNER_TEMP: join(workspace, "tmp"),
        GITHUB_RUN_ID: fixtureValue.run.id,
        GITHUB_REPOSITORY: "acme/app",
        GITHUB_SERVER_URL: "https://github.com",
        ACTIONS_ARTIFACT_UPLOAD_TIMEOUT_MS: "10000",
      },
    },
  ).catch((error) => {
    throw new Error(`${error.message}\nProtocol errors: ${errors.slice(before).join("; ")}`);
  });
  expect(errors.slice(before)).toEqual([]);
  const result = output.stdout.split("\n").find((line) => line.startsWith("RESULT:"));
  expect(result).toBeTruthy();
  return JSON.parse(result!.slice(7)) as { id: number; size?: number; restored?: string };
}

describe("Actions artifact and cache protocols with official action clients", () => {
  it("uploads, lists and downloads an artifact from a different job without giving it storage credentials", async () => {
    const f = await fixture();
    const result = await officialClient("artifact", f);
    const stored = await repositories.actionStorage.get(f.org, result.id);
    expect(stored?.state).toBe("complete");
    expect(stored?.size).toBeGreaterThan(0);
    expect(await repositories.actionStorage.chunks(f.org, result.id)).toEqual([]);
    expect(stored?.reservedBytes).toBe(stored?.size);
  }, 90_000);
  it.each([true, false])(
    "restores cache data and key prefixes with v2=%s",
    async (v2) => {
      const f = await fixture();
      const result = await officialClient("cache", f, v2);
      expect(result.restored).toBe("linux-node-project-lockfile");
    },
    90_000,
  );
  it("rejects another organization and a runtime credential used as an object download token", async () => {
    const f = await fixture();
    const other = await fixture();
    const invalidToken = await tokens.issue(
      { purpose: "runtime", organizationId: other.org, runId: f.run.id, jobId: f.jobs[0]!.id },
      600,
    );
    await expect(
      protocol.handle(
        new Request(`${origin}/twirp/github.actions.results.api.v1.ArtifactService/ListArtifacts`, {
          method: "POST",
          headers: { authorization: `Bearer ${invalidToken}` },
          body: "{}",
        }),
      ),
    ).rejects.toThrow("Forbidden");
    await expect(
      protocol.handle(
        new Request(`${origin}/api/actions/runtime/objects/1?token=${await f.issue(f.jobs[0]!)}`),
      ),
    ).rejects.toMatchObject({ code: "ACTIONS_RUNTIME_UNAUTHORIZED" });
  });
  it("fences late finalization and keeps a tombstone after a storage deletion failure", async () => {
    const f = await fixture();
    const repository = repositories.actionStorage;
    const object = await repository.reserve(
      {
        organizationId: f.org,
        runId: f.run.id,
        jobId: f.jobs[0]!.id,
        destinationId: f.destinationId,
        kind: "artifact",
        repository: "acme/app",
        ref: f.run.ref,
        name: "lease",
        key: "test-lease",
        maxBytes: 10,
        reservedBytes: 40,
        expiresAt: new Date(Date.now() + 60_000),
      },
      100,
      10,
    );
    const first = (await repository.beginAssembly(f.org, object.id, 5))!;
    await connection.db
      .update(schema.actionStorageObject)
      .set({ leaseUntil: new Date(0) })
      .where(eq(schema.actionStorageObject.id, object.id));
    const second = (await repository.beginAssembly(f.org, object.id, 5))!;
    expect(await repository.uploaded(f.org, object.id, first.id, "first-hash")).toBeUndefined();
    expect((await repository.uploaded(f.org, object.id, second.id, "second-hash"))?.finalKey).toBe(
      second.key,
    );
    await repository.complete(f.org, object.id);
    const store = stores.get(`${f.org}:${f.destinationId}`)!;
    const failure = vi
      .spyOn(store, "delete")
      .mockRejectedValueOnce(new Error("storage temporarily unavailable"));
    await expect(protocol.remove((await repository.get(f.org, object.id))!)).rejects.toThrow(
      "temporarily unavailable",
    );
    expect((await repository.get(f.org, object.id))?.state).toBe("deleting");
    failure.mockRestore();
    await protocol.sweep();
    expect(await repository.get(f.org, object.id)).toBeUndefined();
  });
});
