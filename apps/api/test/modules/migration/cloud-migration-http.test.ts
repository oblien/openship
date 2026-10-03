import "../jobs/_env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";

const network = vi.hoisted(() => ({ connect: vi.fn(), exec: vi.fn(), dispose: vi.fn() }));
vi.mock("@repo/platform/engine/config/env", async original => {
  const actual = await original<typeof import("@repo/platform/engine/config/env")>();
  return { ...actual, env: { ...actual.env, CLOUD_MODE: true } };
});
vi.mock("@repo/adapters", async original => ({
  ...await original<typeof import("@repo/adapters")>(),
  createExecutor: network.connect,
}));

import { repos } from "@repo/db";
import { mintPatToken } from "@repo/platform/engine/lib/pat";
import { decryptSecretField, encryptSecretField } from "@repo/platform/engine/lib/credential-encryption";
import { buildSshConfig } from "@repo/platform/engine/lib/ssh-manager";
import { migrationRoutes } from "../../../src/modules/migration/migration.routes";
import { handleApiError } from "../../../src/middleware/error-handler";
import { seedOrg, seedProject, type SeededOrg } from "../../helpers/seed";

// Real router, authentication, permissions, schema, encryption and migrated DB.
// Only the remote SSH handshake is simulated; rejected requests must never dial.
const app = new Hono().onError(handleApiError).route("/api/migration", migrationRoutes);
const hostKey = Buffer.from("fixture-authenticated-host-public-key");
const input = { name: "Import source", sshHost: "93.184.216.34", sshAuthMethod: "password", sshPassword: "fixture-secret" };
type Grants = Parameters<typeof repos.patGrant.createMany>[1];

async function token(owner: SeededOrg, grants?: Grants) {
  const pat = mintPatToken();
  const row = await repos.personalAccessToken.create({
    ...owner, name: "Migration test", tokenPrefix: pat.tokenPrefix, tokenHash: pat.tokenHash,
    readOnly: false, scoped: !!grants, expiresAt: null,
  });
  if (grants) await repos.patGrant.createMany(row.id, grants);
  return pat.token;
}
async function request(method: string, path: string, auth?: string, body?: unknown) {
  const response = await app.request(`/api/migration${path}`, { method,
    headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  let bodyValue: any;
  try { bodyValue = JSON.parse(raw); } catch { bodyValue = raw; }
  return { status: response.status, body: bodyValue };
}
async function runFixture() {
  const owner = await seedOrg();
  const auth = await token(owner);
  const source = await repos.server.create({ organizationId: owner.organizationId, purpose: "migration_source", sshHost: input.sshHost,
    sshAuthMethod: "password", sshPassword: encryptSecretField(input.sshPassword), sshHostKey: hostKey.toString("base64") });
  const workspace = await repos.cloudWorkspace.create({ organizationId: owner.organizationId, name: "Managed destination" });
  const target = (await repos.server.findByWorkspace(workspace.id, owner.organizationId))!;
  const project = await seedProject(owner.organizationId, { serverId: target.id });
  const run = await repos.dockerMigrationRun.create({ id: `mig_${randomUUID()}`, organizationId: owner.organizationId,
    sourceServerId: source.id, targetServerId: target.id, projectId: project.id, projectName: project.name,
    status: "awaiting_cutover", confirmationToken: "fixture-confirmation", mode: "cross_server",
    inputSnapshot: { serviceEnv: { app: { API_KEY: "fixture-runtime-secret" } } },
    recovery: { sourceRunningContainerIds: { app: "original-container" }, transferRunTag: "private-run-marker" },
  });
  return { owner, auth, source, target, project, run: run! };
}

beforeEach(() => {
  vi.clearAllMocks();
  network.exec.mockResolvedValue("");
  network.dispose.mockResolvedValue(undefined);
  network.connect.mockImplementation(config => {
    if (!config.hostVerifier(hostKey)) throw new Error("SSH host key rejected");
    return { exec: network.exec, dispose: network.dispose };
  });
});

describe("Cloud migration HTTP boundaries", () => {
  it("requires authentication before source operations or scanning", async () => {
    for (const [method, path, body] of [["GET", "/sources"], ["POST", "/sources", input],
      ["POST", "/sources/test", input], ["POST", "/scan", { serverId: "unknown" }]] as const) {
      expect((await request(method, path, undefined, body)).status).toBe(401);
    }
    expect(network.connect).not.toHaveBeenCalled();
  });

  it.each([{ sshAuthMethod: "agent" }, { sshKeyPath: "/root/.ssh/id_ed25519" },
    { sshArgs: "-o ProxyCommand=whoami" }, { sshJumpHost: "private-host" },
    { isLocal: true }, { workspaceId: "foreign-workspace" }, { organizationId: "foreign-org" },
    { purpose: "deployment" }])("rejects unsafe or server-controlled fields: %j", async invalid => {
    const auth = await token(await seedOrg());
    expect((await request("POST", "/sources", auth, { ...input, ...invalid })).status).toBe(400);
    expect(network.connect).not.toHaveBeenCalled();
  });

  it.each(["localhost", "127.0.0.1", "169.254.169.254", "10.0.0.1", "::1", "::ffff:127.0.0.1"])(
    "refuses private destination %s before opening a connection", async sshHost => {
      const auth = await token(await seedOrg());
      const response = await request("POST", "/sources", auth, { ...input, sshHost });
      expect(response.status).toBe(400);
      expect(network.connect).not.toHaveBeenCalled();
    });

  it("encrypts saved credentials, pins authenticated host identity and returns no secrets", async () => {
    const owner = await seedOrg();
    const auth = await token(owner);
    const verified = await request("POST", "/sources/test", auth, input);
    expect(verified.status).toBe(200);
    expect(verified.body.fingerprint).toMatch(/^SHA256:/);
    expect(await repos.server.listMigrationSources(owner.organizationId)).toEqual([]);
    const response = await request("POST", "/sources", auth, input);
    expect(response.status).toBe(201);
    const stored = (await repos.server.get(response.body.server.id))!;
    expect(stored.organizationId).toBe(owner.organizationId);
    expect(stored.sshPassword).toMatch(/^enc1:/);
    expect(decryptSecretField(stored.sshPassword)).toBe(input.sshPassword);
    expect(stored.sshHostKey).toBe(hostKey.toString("base64"));
    const config = await buildSshConfig(stored);
    expect((config!.hostVerifier as (key: Buffer) => boolean)(Buffer.from("different-server"))).toBe(false);
    expect(response.body.server.capabilities).toMatchObject({ exec: false, terminal: false, hostConfiguration: false });
    for (const result of [response, await request("GET", "/sources", auth)]) {
      expect(JSON.stringify(result.body)).not.toContain(input.sshPassword);
      expect(JSON.stringify(result.body)).not.toContain("sshHostKey");
    }
    expect(network.dispose).toHaveBeenCalledTimes(2);
  });

  it("never treats a migration source as a destination, or permits in-place Cloud adoption", async () => {
    const { auth, source } = await runFixture();
    const result = await request("POST", "/preview", auth, { sourceServerId: source.id, targetServerId: source.id, serviceNames: ["app"] });
    expect(result.status).toBe(403);
    expect(result.body.code).toBe("MIGRATION_SOURCE_ONLY");
    expect((await request("POST", "/adopt", auth, { serverId: source.id, projectName: "app", serviceNames: ["app"] })).status).toBe(404);
    expect(network.connect).not.toHaveBeenCalled();
  });

  it("isolates source inventory, scans, run state, cutover and disconnect across organizations", async () => {
    const { source, target, run } = await runFixture();
    const foreignAuth = await token(await seedOrg());
    expect((await request("GET", "/sources", foreignAuth)).body.sources).toEqual([]);
    for (const [method, path, body] of [
      ["POST", "/scan", { serverId: source.id }],
      ["GET", `/migrations/${run.id}`],
      ["GET", `/active?serverId=${target.id}`],
      ["GET", `/runs?serverId=${source.id}`],
      ["POST", `/migrations/${run.id}/cutover`, { confirmationToken: run.confirmationToken, kill: true }],
      ["DELETE", `/sources/${source.id}`],
    ] as const) expect((await request(method, path, foreignAuth, body)).status).toBe(404);
    expect(network.connect).not.toHaveBeenCalled();
    expect(await repos.server.get(source.id)).not.toBeNull();
  });

  it("requires scoped access to both endpoints and the project, including history and mutations", async () => {
    const { owner, source, target, project, run } = await runFixture();
    const sourceGrant = { resourceType: "server" as const, resourceId: source.id, permissions: ["read" as const, "write" as const] };
    const serversGrant = { ...sourceGrant, resourceId: "*" };
    const projectGrant = { resourceType: "project" as const, resourceId: project.id, permissions: ["read" as const, "write" as const] };
    // The collection route requires server scope; concrete denials must still
    // win inside the controller. A server grant never implies project access.
    for (const grants of [[serversGrant, { ...sourceGrant, resourceId: target.id, permissions: [] }, projectGrant], [serversGrant]]) {
      const auth = await token(owner, grants);
      expect((await request("GET", `/migrations/${run.id}`, auth)).status).toBe(404);
      const history = await request("GET", `/runs?serverId=${source.id}`, auth);
      expect(history.status, JSON.stringify(history.body)).toBe(200);
      expect(history.body.runs).toEqual([]);
      expect((await request("POST", `/migrations/${run.id}/cutover`, auth, { confirmationToken: run.confirmationToken, kill: true })).status).toBe(404);
    }
    const allowed = await token(owner, [serversGrant, projectGrant]);
    const detail = await request("GET", `/migrations/${run.id}`, allowed);
    expect(detail.status).toBe(200);
    expect(detail.body.run.confirmationToken).toBe(run.confirmationToken);
    expect(detail.body.run).not.toHaveProperty("recovery");
    expect(JSON.stringify(detail.body)).not.toContain("fixture-runtime-secret");
    const history = await request("GET", `/runs?serverId=${source.id}`, allowed);
    expect(history.body.runs).toHaveLength(1);
    expect(history.body.runs[0]).not.toHaveProperty("confirmationToken");
    expect(history.body.runs[0]).not.toHaveProperty("inputSnapshot");
    expect(history.body.runs[0]).not.toHaveProperty("recovery");
  });

  it("preserves the source connection until all migration and recovery work finishes", async () => {
    const { auth, source, run } = await runFixture();
    expect((await request("DELETE", `/sources/${source.id}`, auth)).status).toBe(409);
    await repos.dockerMigrationRun.transition(run.id, "rolled_back");
    // A terminal outcome with a leftover trust marker is still recoverable work.
    expect((await request("DELETE", `/sources/${source.id}`, auth)).status).toBe(409);
    await repos.dockerMigrationRun.updateRecovery(run.id, { transferRunTag: null });
    expect((await request("DELETE", `/sources/${source.id}`, auth)).status).toBe(200);
    expect(await repos.server.get(source.id)).toBeUndefined();
  });
});
