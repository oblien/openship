import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createLocalJWKSet, jwtVerify } from "jose";
import {
  createDatabase,
  createRepositories,
  schema,
  type DatabaseConnection,
} from "@repo/db/factory";
import { createEncryption } from "@repo/db/encryption";
import type { ActionJob, ActionRun } from "@repo/db";
import { ActionOidcService, type ActionOidcPorts } from "./oidc-service";
import { ActionRuntimeTokens } from "./runtime-identity";

let connection: DatabaseConnection;
let repo: ReturnType<typeof createRepositories>["actionOidc"];
const encryption = createEncryption("long-and-random-test-controller-secret-for-signing-storage");
const tokens = new ActionRuntimeTokens("private-request-capability-secret");
const issuer = "https://ci.example.test/api/actions/oidc";
beforeAll(async () => {
  connection = await createDatabase({ driver: "pglite", dataDir: "memory://" });
  repo = createRepositories(connection.db, encryption).actionOidc;
}, 60000);
afterAll(async () => {
  await connection?.close();
  encryption.close();
});

function fixture() {
  const run = {
    id: "run-one",
    organizationId: "org-one",
    controller: "openship",
    status: "running",
    ref: "refs/heads/main",
    revision: "a".repeat(40),
    actor: "author",
    number: 3,
    attempt: 2,
    eventName: "push",
    event: { repository: { id: 123, owner: { id: 45 } } },
    plan: { name: "CI" },
    authority: { userId: "owner" },
    configuration: {
      owner: "acme",
      repo: "app",
      actorIdentity: { id: "45", login: "author" },
      workflows: {
        root: {
          owner: "acme",
          repo: "app",
          path: ".openship/workflows/ci.yml",
          ref: "refs/heads/main",
          sha: "a".repeat(40),
        },
        reusable: {
          owner: "acme",
          repo: "ci",
          path: ".github/workflows/deploy.yml",
          ref: "refs/tags/v1",
          sha: "b".repeat(40),
        },
      },
    },
  } as unknown as ActionRun;
  const job = {
    id: "job-one",
    runId: run.id,
    organizationId: run.organizationId,
    status: "running",
    runnerId: "runner-one",
    workerStartedAt: new Date(),
    spec: {
      permissions: { "id-token": "write" },
      timeoutSeconds: 600,
      scope: [{ sourceId: "reusable" }],
    },
  } as unknown as ActionJob;
  const authorize = vi.fn(async () => ({ run, job }));
  const ports: ActionOidcPorts = {
    issuer: () => issuer,
    tokens,
    ...repo,
    encrypt: encryption.encrypt,
    decrypt: encryption.decrypt,
    authorize,
  };
  return { run, job, ports, service: new ActionOidcService(ports) };
}
async function request(
  f: ReturnType<typeof fixture>,
  token?: string,
  audience = "sts.amazonaws.com",
) {
  const environment = await f.service.environment(f.run, f.job);
  return new Request(
    `${environment.ACTIONS_ID_TOKEN_REQUEST_URL}&audience=${encodeURIComponent(audience)}`,
    { headers: { Authorization: `Bearer ${token ?? environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` } },
  );
}

describe("Openship Actions OIDC", () => {
  it("keeps public verification available but refuses to replace an imported identity without credentials", async () => {
    const f = fixture();
    const original = await f.service.jwks();
    const saved = (await repo.key(issuer))!;
    const ports = { ...f.ports, key: async () => ({ ...saved, privateKeyEnc: "" }) };
    const restored = new ActionOidcService(ports);
    expect(await restored.jwks()).toEqual(original);
    await expect(restored.environment(f.run, f.job)).rejects.toMatchObject({
      code: "ACTIONS_OIDC_CREDENTIALS_MISSING",
    });
  });
  it("persists one encrypted RSA identity across racing controllers and signs verifiable, tenant-bound claims", async () => {
    const f = fixture();
    const second = new ActionOidcService(f.ports);
    const [one, two] = await Promise.all([f.service.jwks(), second.jwks()]);
    expect(one).toEqual(two);
    expect(one.keys[0]).not.toHaveProperty("d");
    const saved = await repo.key(issuer);
    expect(saved!.privateKeyEnc).not.toContain("PRIVATE KEY");
    expect(await connection.db.select().from(schema.actionOidcKey)).toHaveLength(1);
    const response = await f.service.token(await request(f));
    const { payload } = await jwtVerify(response.value, createLocalJWKSet(one), {
      issuer,
      audience: "sts.amazonaws.com",
      algorithms: ["RS256"],
    });
    expect(payload).toMatchObject({
      sub: "openship:organization:org-one:repo:acme/app:ref:refs/heads/main",
      repository_id: "123",
      run_id: "run-one",
      run_attempt: "2",
      openship_job_id: "job-one",
      job_workflow_ref: "acme/ci/.github/workflows/deploy.yml@refs/tags/v1",
      job_workflow_sha: "b".repeat(40),
    });
    expect(payload.exp! - payload.iat!).toBe(300);
    expect(new ActionOidcService(f.ports).discovery().issuer).toBe(issuer);
    await expect(
      jwtVerify(response.value, createLocalJWKSet(one), { issuer, audience: "other" }),
    ).rejects.toThrow();
  });
  it("rejects artifact capabilities, modified credentials and other-job requests", async () => {
    const f = fixture();
    const runtime = await tokens.issue(
      { organizationId: "org-one", runId: "run-one", jobId: "job-one", purpose: "runtime" },
      60,
    );
    await expect(f.service.token(await request(f, runtime))).rejects.toMatchObject({
      statusCode: 401,
    });
    const env = await f.service.environment(f.run, f.job);
    await expect(
      f.service.token(await request(f, `${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}tampered`)),
    ).rejects.toMatchObject({ statusCode: 401 });
    const req = await request(f);
    await expect(
      f.service.token(new Request(req.url.replace("job=job-one", "job=other"), req)),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(f.ports.authorize).not.toHaveBeenCalled();
  });
  it.each([
    "cancelled",
    "finished",
    "queued-run",
    "queued-job",
    "revoked",
    "fork",
    "permission",
    "foreign-tenant",
    "foreign-run",
  ])("does not mint for %s execution", async (state) => {
    const f = fixture();
    const req = await request(f);
    if (state === "cancelled") f.job.cancelRequestedAt = new Date();
    if (state === "finished") f.run.finishedAt = new Date();
    if (state === "queued-run") f.run.status = "queued";
    if (state === "queued-job") f.job.status = "queued";
    if (state === "revoked")
      f.ports.authorize = vi.fn(async () => {
        throw new Error("authority revoked");
      });
    if (state === "fork") f.run.untrusted = true;
    if (state === "permission") f.job.spec!.permissions = {};
    if (state === "foreign-tenant") f.run.organizationId = "other";
    if (state === "foreign-run") f.run.id = "other";
    await expect(f.service.token(req)).rejects.toThrow();
  });
  it("does not send credentials without the grant, validates audiences and expires request capabilities", async () => {
    const f = fixture();
    const req = await request(f);
    await expect(f.service.token(await request(f, undefined, " "))).rejects.toMatchObject({
      statusCode: 400,
    });
    f.job.spec!.permissions = {};
    expect(await f.service.environment(f.run, f.job)).toEqual({});
    f.job.spec!.permissions = { "id-token": "write" };
    f.run.untrusted = true;
    expect(await f.service.environment(f.run, f.job)).toEqual({});
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 901000);
      await expect(f.service.token(req)).rejects.toMatchObject({ statusCode: 401 });
    } finally {
      vi.useRealTimers();
    }
  });
});
