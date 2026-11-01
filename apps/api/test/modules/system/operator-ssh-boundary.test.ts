import "../jobs/_env";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { serverResourceRoutes } from "../../../src/modules/system/server-resource.routes";
import { serverManagementRoutes } from "../../../src/modules/system/server-management.routes";
import { handleApiError } from "../../../src/middleware/error-handler";
import { toAdapterRow } from "@repo/platform/engine/modules/backup-destinations/hydrate-server";
import { repos } from "@repo/db";
import { seedBackupDestination } from "../../helpers/seed";
import { seedOwner } from "../jobs/_harness";
import { env } from "@repo/platform/engine/config/env";
import { buildSshConfig } from "@repo/platform/engine/lib/ssh-manager";
import { clearBoxOwningOrgCache } from "@repo/platform/engine/lib/box-org";

let owner: Awaited<ReturnType<typeof seedOwner>>;
let other: Awaited<ReturnType<typeof seedOwner>>;
let directory: string;
const oldRoots = env.SSH_KEY_PATH_ROOTS;
const oldCloud = env.CLOUD_MODE;
beforeAll(async () => {
  owner = await seedOwner({ instanceAdmin: true });
  other = await seedOwner();
  directory = await mkdtemp(join(tmpdir(), "openship-audit-ssh-"));
  await writeFile(join(directory, "test-key"), "synthetic operator key; never used to connect");
  env.SSH_KEY_PATH_ROOTS = directory;
  clearBoxOwningOrgCache();
});
afterEach(() => {
  env.CLOUD_MODE = oldCloud;
  vi.unstubAllEnvs();
});
afterAll(async () => {
  env.SSH_KEY_PATH_ROOTS = oldRoots;
  clearBoxOwningOrgCache();
  await rm(directory, { recursive: true, force: true });
});
const settings = (organizationId: string) => ({
  organizationId,
  sshHost: "ssh.example.test",
  sshUser: "root",
  sshAuthMethod: "key",
  sshKeyPath: join(directory, "test-key"),
});
const app = new Hono()
  .onError(handleApiError)
  .route("/api/system", serverResourceRoutes)
  .route("/api/system", serverManagementRoutes);

describe("control-plane SSH credentials", () => {
  it("does not lend the operator's key file to another tenant's server", async () => {
    await expect(buildSshConfig(settings(other.orgId))).rejects.toMatchObject({
      code: "OPERATOR_SSH_ACCESS_REQUIRED",
    });
  });
  it("keeps the host-owning organization's configured key working", async () => {
    expect(await buildSshConfig(settings(owner.orgId))).toMatchObject({
      privateKey: "synthetic operator key; never used to connect",
    });
  });
  it("allows other tenants to use their own uploaded key", async () => {
    expect(
      await buildSshConfig({
        ...settings(other.orgId),
        sshKeyPath: null,
        sshPrivateKey: "tenant's own key",
      }),
    ).toMatchObject({ privateKey: "tenant's own key" });
  });
  it("never exposes operator files to Cloud tenants, including the founding account", async () => {
    env.CLOUD_MODE = true;
    vi.stubEnv("OPENSHIP_NATIVE", "true");
    vi.stubEnv("OPENSHIP_NATIVE_ALLOW_HOST_EXECUTION", "true");
    await expect(buildSshConfig(settings(owner.orgId))).rejects.toMatchObject({
      code: "OPERATOR_SSH_ACCESS_REQUIRED",
    });
  });
  it.each([
    { sshAuthMethod: "agent" },
    { sshAuthMethod: "password", sshTransport: "cloudflare" },
    { sshAuthMethod: "password", sshJumpHost: "bastion.example.test" },
  ])(
    "rejects another workspace's operator-dependent connection at creation: %j",
    async (connection) => {
      const response = await app.request("/api/system/servers", {
        method: "POST",
        headers: { ...other.auth, "content-type": "application/json" },
        body: JSON.stringify({ sshHost: "ssh.example.test", ...connection }),
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "OPERATOR_SSH_ACCESS_REQUIRED" });
    },
  );
  it("also rejects a retained server-backed backup before reading the operator key", async () => {
    const server = await repos.server.create(settings(other.orgId));
    const row = await seedBackupDestination(other.orgId, {
      kind: "openship_server",
      serverId: server.id,
    });
    await expect(toAdapterRow(row)).rejects.toMatchObject({ code: "OPERATOR_SSH_ACCESS_REQUIRED" });
  });
});
