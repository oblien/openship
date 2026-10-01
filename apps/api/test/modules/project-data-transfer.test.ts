import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, eq, schema, sql, repos } from "@repo/db";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { env } from "@repo/platform/engine/config/env";

vi.mock("@repo/platform/engine/config/env", async () => ({
  env: { BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? (await import("@repo/db/encryption")).DEFAULT_ENCRYPTION_SECRET, CLOUD_MODE: false },
}));
vi.mock("../../src/lib/database-runtime-state", () => ({
  reconcileRuntimeStateAfterImport: vi.fn(),
}));
vi.mock("../../src/modules/system/migration/migration-lock", () => ({
  withMigrationLock: (fn: () => Promise<unknown>) => fn(),
  reassertMigrationLockAfterRestore: vi.fn(),
}));
vi.mock("@repo/platform/engine/lib/cloud/session", () => ({
  getCloudConnectionStatusForOrg: vi.fn(async () => ({ connected: false })),
}));

import { getCloudConnectionStatusForOrg } from "@repo/platform/engine/lib/cloud/session";
import { encrypt, decrypt } from "@repo/platform/engine/lib/encryption";
import { encryptSecretField, decryptSecretField } from "@repo/platform/engine/lib/credential-encryption";
import {
  exportInstance,
  previewInstanceExport,
} from "../../src/modules/system/data-transfer/export.service";
import {
  importInstance,
  importPreparedInstance,
  previewInstanceImport,
} from "../../src/modules/system/data-transfer/import.service";
import { openTransferSecrets, sealSecretBundle } from "../../src/modules/system/data-transfer/passphrase-crypto";
import {
  createFileUpload,
  finalizeFileUpload,
  previewFileUpload,
  uploadFileChunk,
} from "../../src/modules/system/data-transfer/file-upload.service";
import { getSession, sha256Hex } from "../../src/modules/system/data-transfer/chunk-store";
import type {
  DataTransferFile,
  ExportSelection,
  ImportSelection,
} from "../../src/modules/system/data-transfer/types";

const context = { userId: "user_target", organizationId: "org_target" };
const sourceContext = { userId: "user_source", organizationId: "org_source" };
const selection: ExportSelection = {
  scope: "projects",
  projectIds: ["web"],
  history: ["backups"],
  includeSecrets: true,
};
const password = "portable-project-test-password";

async function reset() {
  // VITEST's db driver is an isolated in-memory PGlite, with real FK checks.
  await db.execute(
    sql`TRUNCATE TABLE "organization", "user", "servers", "instance_settings", "data_transfer_session" CASCADE`,
  );
}
async function identity(orgId: string, userId: string) {
  await db
    .insert(schema.user)
    .values({ id: userId, name: userId, email: `${userId}@example.test`, role: "admin" });
  await db
    .insert(schema.organization)
    .values({ id: orgId, name: orgId, slug: orgId, createdAt: new Date() });
  await db
    .insert(schema.member)
    .values({
      id: `member_${orgId}`,
      organizationId: orgId,
      userId,
      role: "owner",
      createdAt: new Date(),
    });
}
async function source() {
  await identity("org_source", "user_source");
  await db.insert(schema.servers).values([
    {
      id: "source_server",
      organizationId: "org_source",
      name: "App host",
      sshHost: "203.0.113.10",
      sshPrivateKey: encryptSecretField("source-ssh-private-key"),
    },
    {
      id: "backup_server",
      organizationId: "org_source",
      name: "Backup host",
      sshHost: "203.0.113.20",
      sshPassword: encryptSecretField("backup-ssh-password"),
    },
  ]);
  await db.insert(schema.projectGroup).values([
    { id: "group_web", organizationId: "org_source", name: "Web", slug: "web" },
    { id: "group_db", organizationId: "org_source", name: "Database", slug: "database" },
    { id: "group_other", organizationId: "org_source", name: "Unrelated", slug: "unrelated" },
  ]);
  await db.insert(schema.project).values([
    {
      id: "web",
      organizationId: "org_source",
      groupId: "group_web",
      name: "Web",
      slug: "web",
      serverId: "source_server",
      activeDeploymentId: "deploy_web",
      gitOwner: "owner",
      gitRepo: "web",
      buildCommand: "npm run build",
      cloneTokenEncrypted: encrypt("project-clone-token"),
    },
    {
      id: "staging",
      organizationId: "org_source",
      groupId: "group_web",
      name: "Web",
      slug: "web-staging",
      environmentName: "Staging",
      environmentSlug: "staging",
      serverId: "source_server",
    },
    {
      id: "database",
      organizationId: "org_source",
      groupId: "group_db",
      name: "Database",
      slug: "database",
      serverId: "source_server",
      isApp: true,
    },
    {
      id: "unrelated",
      organizationId: "org_source",
      groupId: "group_other",
      name: "Unrelated",
      slug: "unrelated",
      serverId: "source_server",
    },
  ]);
  await db
    .insert(schema.service)
    .values({
      id: "service_web",
      projectId: "web",
      name: "web",
      image: "nginx:alpine",
      environment: { INLINE_PASSWORD: "inline-secret" },
      buildArgs: { BUILD_TOKEN: "build-secret" },
      advanced: {
        files: [{ path: "/run/secrets/key", content: "private-file-contents" }],
      } as never,
    });
  await db.insert(schema.envVar).values([
    { id: "env_web", projectId: "web", key: "API_KEY", value: encrypt("environment-secret") },
    {
      id: "env_service",
      projectId: "web",
      serviceId: "service_web",
      key: "DB_PASSWORD",
      value: encrypt("service-secret"),
    },
    { id: "env_other", projectId: "unrelated", key: "PRIVATE", value: encrypt("unrelated-secret") },
  ]);
  await db.insert(schema.deployment).values({
    id: "deploy_web",
    projectId: "web",
    organizationId: "org_source",
    branch: "main",
    status: "ready",
    containerId: "running-container",
    meta: {
      organizationId: "org_source",
      serverId: "source_server",
      deployTarget: "server",
      targetServiceIds: ["service_web"],
      composeServices: [
        {
          id: "service_web",
          projectId: "web",
          name: "web",
          environment: { PASSWORD: "frozen-compose-secret", serviceId: "service_web" },
        },
      ],
    },
    envVars: { API_KEY: encrypt("snapshot-secret") },
  });
  await db
    .insert(schema.serviceDeployment)
    .values({
      id: "service_deploy",
      deploymentId: "deploy_web",
      serviceId: "service_web",
      containerId: "running-service",
      status: "running",
    });
  await db
    .insert(schema.domain)
    .values({
      id: "domain_web",
      projectId: "web",
      serviceId: "service_web",
      hostname: "web.example.test",
      status: "active",
      verified: true,
      sslStatus: "active",
    });
  await db
    .insert(schema.projectConnection)
    .values({
      id: "link_db",
      organizationId: "org_source",
      sourceProjectId: "database",
      targetProjectId: "web",
      outputId: "dbUrl",
      envKey: "DATABASE_URL",
    });
  await db
    .insert(schema.gitSource)
    .values({
      id: "git_source",
      organizationId: "org_source",
      name: "Private Git App",
      appId: 42,
      slug: "private-git-app",
      webhookUrl: "https://source.example.test/api/github/webhook",
      secretsEnc: encryptSecretField(
        JSON.stringify({ privateKeyPem: "git-app-private-key", clientSecret: "git-client-secret" }),
      )!,
      isDefault: true,
    });
  await db
    .insert(schema.gitInstallation)
    .values({
      id: "git_install",
      userId: "user_source",
      organizationId: "org_source",
      sourceId: "git_source",
      installationId: 42,
      owner: "owner",
    });
  await db.update(schema.project).set({ installationId: 42 }).where(eq(schema.project.id, "web"));
  await db
    .insert(schema.credential)
    .values({
      id: "registry",
      organizationId: "org_source",
      provider: "docker-registry",
      name: "Registry",
      selector: "registry.example.test",
      secretsEnc: encryptSecretField(
        JSON.stringify({ username: "robot", password: "registry-secret" }),
      )!,
    });
  await db
    .insert(schema.dnsCredential)
    .values({
      id: "dns",
      organizationId: "org_source",
      provider: "cloudflare",
      name: "DNS",
      apiTokenEnc: encryptSecretField("dns-secret")!,
    });
  await db
    .insert(schema.backupDestination)
    .values({
      id: "destination",
      organizationId: "org_source",
      name: "Offsite",
      kind: "openship_server",
      serverId: "backup_server",
      pathPrefix: "/backups",
    });
  await db
    .insert(schema.backupPolicy)
    .values({
      id: "policy",
      projectId: "web",
      serviceId: "service_web",
      destinationId: "destination",
      webhookToken: "backup-trigger-secret",
      createdBy: "user_source",
    });
  await db
    .insert(schema.backupRun)
    .values({
      id: "backup_run",
      organizationId: "org_source",
      policyId: "policy",
      destinationId: "destination",
      projectId: "web",
      serviceId: "service_web",
      status: "succeeded",
      triggeredBy: "manual",
    });
  await db
    .insert(schema.serverGithubAuth)
    .values({
      id: "server_git",
      serverId: "source_server",
      organizationId: "org_source",
      mode: "ssh-deploy-key",
    });
  await db
    .insert(schema.githubDeployKey)
    .values({
      id: "deploy_key",
      serverId: "source_server",
      organizationId: "org_source",
      owner: "owner",
      repo: "web",
      privateKeyEncrypted: encrypt("repo-private-key"),
      publicKey: "repo-public-key",
    });
  await db
    .insert(schema.githubDeployKey)
    .values({
      id: "other_key",
      serverId: "source_server",
      organizationId: "org_source",
      owner: "owner",
      repo: "unrelated",
      privateKeyEncrypted: encrypt("unrelated-key"),
      publicKey: "other-public-key",
    });
}
async function exportFile(overrides: Partial<ExportSelection> = {}, passwordProtected = true): Promise<DataTransferFile> {
  const file: DataTransferFile = JSON.parse(JSON.stringify(
    await exportInstance({ selection: { ...selection, ...overrides } }),
  ));
  if (passwordProtected) {
    // Manufacture a legacy archive to keep testing old password-protected
    // imports. New downloads always use plaintext, even for older clients.
    const bundle = openTransferSecrets(file.secrets);
    file.envelopeVersion = 2;
    file.secrets = bundle ? sealSecretBundle(bundle, password) : null;
  }
  return file;
}
async function destination(withServer = true) {
  await reset();
  await identity(context.organizationId, context.userId);
  if (withServer)
    await db
      .insert(schema.servers)
      .values({
        id: "target_server",
        organizationId: context.organizationId,
        name: "Existing app host",
        sshHost: "203.0.113.10",
        sshPassword: encryptSecretField("destination-password"),
      });
}

beforeEach(async () => {
  await reset();
  vi.mocked(getCloudConnectionStatusForOrg).mockResolvedValue({ connected: false });
});

describe("project control-plane export and import", () => {
  it.each(["missing", "other-project", "other-organization"])(
    "rejects a %s active-deployment binding in both preview and apply before writing",
    async (kind) => {
      await source();
      const file = await exportFile();
      const project = file.dump.tables.project!.find((row) => row.id === "web")!;
      const deployment = file.dump.tables.deployment!.find((row) => row.id === "deploy_web")!;
      if (kind === "missing") project.activeDeploymentId = "outside-the-archive";
      else if (kind === "other-project") deployment.projectId = "database";
      else deployment.organizationId = "foreign-org";
      await destination();
      await expect(previewInstanceImport({ file, context })).rejects.toThrow(/active deployment.*same project and organization/);
      await expect(importInstance({ file, passphrase: password, mode: "merge", context })).rejects.toThrow(/active deployment.*same project and organization/);
      expect(await db.select().from(schema.project)).toHaveLength(0);
      expect(await db.select().from(schema.deployment)).toHaveLength(0);
    },
  );

  it("keeps legacy sealed archives readable with all selected dependencies and no unrelated projects", async () => {
    await source();
    const file = await exportFile();
    expect(file.kind).toBe("openship-project-export");
    expect(file.dump.tables.project!.map((row) => row.id).sort()).toEqual([
      "database",
      "staging",
      "web",
    ]);
    expect(file.dump.tables.servers!.map((row) => row.id).sort()).toEqual([
      "backup_server",
      "source_server",
    ]);
    expect(file.dump.tables.github_deploy_key!.map((row) => row.id)).toEqual(["deploy_key"]);
    expect(file.dump.tables.backup_policy).toHaveLength(1);
    expect(file.dump.tables.backup_destination).toHaveLength(1);
    expect(file.dump.tables.backup_run).toHaveLength(1);
    expect(file.dump.tables.git_source).toHaveLength(1);
    expect(file.dump.tables.git_installation).toHaveLength(1);
    expect(file.dump.tables.credential).toHaveLength(1);
    expect(file.dump.tables.dns_credential).toHaveLength(1);
    for (const table of [
      "user",
      "account",
      "organization",
      "user_settings",
      "instance_settings",
      "session",
    ])
      expect(file.dump.tables[table]).toBeUndefined();
    for (const value of [
      "environment-secret",
      "inline-secret",
      "private-file-contents",
      "frozen-compose-secret",
      "project-clone-token",
      "repo-private-key",
      "backup-trigger-secret",
      "git-app-private-key",
      "registry-secret",
      "dns-secret",
    ])
      expect(JSON.stringify(file)).not.toContain(value);
    expect(file.manifest?.projects).toHaveLength(3);
    const secrets = openTransferSecrets(file.secrets, password)!;
    expect(secrets.entries).toContainEqual(
      expect.objectContaining({
        table: "service",
        column: "environment",
        json: { INLINE_PASSWORD: "inline-secret" },
      }),
    );
  });

  it("exports readable environment values, keys, and service configuration without a password", async () => {
    await source();
    const file = await exportFile({}, false);
    expect(file.envelopeVersion).toBe(4);
    expect(file.secrets).toMatchObject({ encoding: "plaintext", version: 1 });
    expect(file.secrets).not.toHaveProperty("kdf");
    for (const value of [
      "environment-secret", "service-secret", "inline-secret", "private-file-contents",
      "frozen-compose-secret", "snapshot-secret", "project-clone-token", "repo-private-key",
      "backup-trigger-secret", "git-app-private-key", "registry-secret", "dns-secret",
      "source-ssh-private-key", "backup-ssh-password",
    ]) expect(JSON.stringify(file)).toContain(value);
    expect(file.manifest?.servers).toContainEqual(expect.objectContaining({
      name: "App host", host: "203.0.113.10",
    }));
    expect(file.dump.tables.project!.map((row) => row.id).sort()).toEqual(["database", "staging", "web"]);
  });

  it.each(["instance", "projects"] as const)("keeps new %s downloads plaintext even when an older client supplies a password", async (scope) => {
    await source();
    const file = await exportInstance({ passphrase: password,
      selection: scope === "projects" ? selection : { scope, history: ["analytics"] },
    });
    expect(file.envelopeVersion).toBe(4);
    expect(file.secrets).toMatchObject({ encoding: "plaintext" });
    expect(openTransferSecrets(file.secrets)!.entries).toContainEqual(expect.objectContaining({
      table: "env_var", id: "env_web", value: "environment-secret",
    }));
  });

  it("preserves passkeys and re-encrypts 2FA through a complete instance transfer", async () => {
    const originalKey = env.BETTER_AUTH_SECRET;
    const sourceKey = "source-account-security-secret-000000000000";
    const destinationKey = "destination-account-security-secret-000000";
    const seed = "transfer-authenticator-seed";
    const recovery = '["one-time-recovery-code"]';
    try {
      env.BETTER_AUTH_SECRET = sourceKey;
      await identity(sourceContext.organizationId, sourceContext.userId);
      await db.update(schema.user).set({ twoFactorEnabled: true }).where(eq(schema.user.id, sourceContext.userId));
      await db.insert(schema.twoFactor).values({
        id: "transfer-factor", userId: sourceContext.userId,
        secret: await symmetricEncrypt({ key: sourceKey, data: seed }),
        backupCodes: await symmetricEncrypt({ key: sourceKey, data: recovery }),
      });
      await db.insert(schema.passkey).values({
        id: "transfer-passkey", userId: sourceContext.userId, name: "Laptop",
        credentialID: "test-credential", publicKey: "test-public-key", counter: 42,
        deviceType: "multiDevice", backedUp: true,
      });
      const file: DataTransferFile = JSON.parse(JSON.stringify(await exportInstance({ selection: { scope: "instance", includeSecrets: true } })));
      // Account secrets travel only in the explicit credential bundle. The
      // metadata portion cannot inject source ciphertext into the destination.
      expect(JSON.stringify(file.dump)).not.toContain(seed);
      expect(JSON.stringify(file.dump)).not.toContain(recovery);
      await reset();
      env.BETTER_AUTH_SECRET = destinationKey;
      await importInstance({ file, mode: "wipe" });
      const [user] = await db.select().from(schema.user).where(eq(schema.user.id, sourceContext.userId));
      const [factor] = await db.select().from(schema.twoFactor);
      expect(user!.twoFactorEnabled).toBe(true);
      expect(await symmetricDecrypt({ key: destinationKey, data: factor!.secret })).toBe(seed);
      expect(await symmetricDecrypt({ key: destinationKey, data: factor!.backupCodes })).toBe(recovery);
      await expect(symmetricDecrypt({ key: sourceKey, data: factor!.secret })).rejects.toThrow();
      expect((await db.select().from(schema.passkey))[0]).toMatchObject({ credentialID: "test-credential", counter: 42, userId: user!.id });

      // A later merge must not replace credentials already owned by the target.
      const replacement = await symmetricEncrypt({ key: destinationKey, data: "replacement-authenticator-seed" });
      await db.update(schema.twoFactor).set({ secret: replacement }).where(eq(schema.twoFactor.id, factor!.id));
      await importInstance({ file, mode: "merge" });
      expect((await db.select().from(schema.twoFactor))[0]!.secret).toBe(replacement);
      await expect(importInstance({ file, mode: "wipe", selection: { scope: "instance", includeSecrets: false } })).rejects.toThrow("Include their credentials");
      expect((await db.select().from(schema.twoFactor))[0]!.secret).toBe(replacement);
    } finally {
      env.BETTER_AUTH_SECRET = originalKey;
    }
  });

  it("exports a complete plaintext instance and replaces older destination records", async () => {
    await source();
    await db.insert(schema.serverAnalytics).values({
      id: "instance_traffic", serverId: "source_server", domain: "web.example.test",
      minute: 1234, requests: 42,
    });
    const file: DataTransferFile = JSON.parse(JSON.stringify(await exportInstance({})));
    expect(file.kind).toBe("openship-instance-export");
    expect(file.envelopeVersion).toBe(4);
    expect(file.secrets).toMatchObject({ encoding: "plaintext", version: 1 });
    expect(file.secrets).not.toHaveProperty("kdf");
    for (const value of [
      "environment-secret", "service-secret", "inline-secret", "snapshot-secret",
      "frozen-compose-secret", "source-ssh-private-key", "backup-ssh-password",
      "project-clone-token", "repo-private-key", "git-app-private-key", "registry-secret",
    ]) expect(JSON.stringify(file)).toContain(value);

    await db.update(schema.envVar).set({ value: encrypt("older-env") }).where(eq(schema.envVar.id, "env_web"));
    await db.update(schema.project).set({ buildCommand: "older-build" }).where(eq(schema.project.id, "web"));
    await db.update(schema.servers).set({ sshPrivateKey: encryptSecretField("older-key") }).where(eq(schema.servers.id, "source_server"));
    await db.update(schema.serverAnalytics).set({ requests: 2 }).where(eq(schema.serverAnalytics.id, "instance_traffic"));
    await db.insert(schema.envVar).values({ id: "destination_only", projectId: "web", key: "REMOVED", value: encrypt("stale") });

    const result = await importInstance({ file, mode: "wipe" });
    expect(result.secretsSkipped).toBe(false);
    expect(decrypt((await db.select().from(schema.envVar).where(eq(schema.envVar.id, "env_web")))[0]!.value)).toBe("environment-secret");
    expect(await db.select().from(schema.envVar).where(eq(schema.envVar.id, "destination_only"))).toHaveLength(0);
    expect((await db.select().from(schema.project).where(eq(schema.project.id, "web")))[0]!.buildCommand).toBe("npm run build");
    expect(decryptSecretField((await db.select().from(schema.servers).where(eq(schema.servers.id, "source_server")))[0]!.sshPrivateKey)).toBe("source-ssh-private-key");
    expect((await db.select().from(schema.serverAnalytics))[0]!.requests).toBe(42);
    expect((await repos.service.findById("service_web"))!.environment).toEqual({ INLINE_PASSWORD: "inline-secret" });
    expect((await repos.deployment.findById("deploy_web"))!.meta).toMatchObject({
      serverId: "source_server", composeServices: [{ environment: { PASSWORD: "frozen-compose-secret" } }],
    });
  });

  it("rolls back instance replacement when finalization fails", async () => {
    await source();
    const file = await exportInstance({});
    await db.update(schema.envVar).set({ value: encrypt("keep-on-failure") }).where(eq(schema.envVar.id, "env_web"));
    await expect(importInstance({
      file, mode: "wipe", onBeforeCommit: async () => { throw new Error("finalization failed"); },
    })).rejects.toThrow("finalization failed");
    expect(decrypt((await db.select().from(schema.envVar).where(eq(schema.envVar.id, "env_web")))[0]!.value)).toBe("keep-on-failure");
    expect(await db.select().from(schema.project)).toHaveLength(4);
  });

  it("overwrites cleared credentials and removes stale project environment rows", async () => {
    await source();
    await db.update(schema.project).set({ cloneTokenEncrypted: null }).where(eq(schema.project.id, "web"));
    await db.update(schema.service).set({ environment: {}, buildArgs: {} }).where(eq(schema.service.id, "service_web"));
    const file = await exportFile({ includeEnvironments: false, includeLinkedProjects: false }, false);
    await db.update(schema.project).set({ cloneTokenEncrypted: encrypt("removed-token") }).where(eq(schema.project.id, "web"));
    await db.update(schema.service).set({ environment: { STALE: "old" }, buildArgs: { STALE: "old" } }).where(eq(schema.service.id, "service_web"));
    await db.insert(schema.envVar).values({ id: "obsolete_env", projectId: "web", key: "OBSOLETE", value: encrypt("old") });

    await importInstance({
      file, mode: "merge", context: { organizationId: "org_source", userId: "user_source" },
      selection: { scope: "projects", conflictPolicy: "overwrite", includeSecrets: true },
    });
    expect((await repos.project.findById("web"))!.cloneTokenEncrypted).toBeNull();
    expect((await repos.service.findById("service_web"))!.environment).toEqual({});
    expect((await repos.service.findById("service_web"))!.buildArgs).toEqual({});
    expect(await db.select().from(schema.envVar).where(eq(schema.envVar.id, "obsolete_env"))).toHaveLength(0);
    expect(decrypt((await db.select().from(schema.envVar).where(eq(schema.envVar.id, "env_other")))[0]!.value)).toBe("unrelated-secret");
  });

  it("replaces destination-only services, connections, deployments and selected history atomically", async () => {
    await source();
    const file = await exportFile({ history: ["analytics"], includeEnvironments: false }, false);
    await db.insert(schema.service).values({ id: "old_service", projectId: "web", name: "old" });
    await db.insert(schema.envVar).values({ id: "old_service_env", projectId: "web", serviceId: "old_service", key: "OLD", value: encrypt("old") });
    await db.insert(schema.deployment).values({ id: "old_deploy", projectId: "web", organizationId: "org_source", branch: "main", status: "ready" });
    await db.insert(schema.serviceDeployment).values({ id: "old_service_deploy", deploymentId: "old_deploy", serviceId: "old_service" });
    await db.update(schema.project).set({ activeDeploymentId: "old_deploy", cloneTokenEncrypted: encrypt("destination-token") }).where(eq(schema.project.id, "web"));
    await db.insert(schema.projectConnection).values({
      id: "old_link", organizationId: "org_source", sourceProjectId: "database", targetProjectId: "web", outputId: "dbUrl", envKey: "OLD_DB",
    });
    await db.insert(schema.serverAnalytics).values({ id: "old_traffic", serverId: "source_server", domain: "web.example.test", minute: 1234 });
    await db.insert(schema.resourceUsage).values([
      { id: "old_usage", projectId: "web", serviceKey: "old_service", minute: 1235 },
      { id: "other_usage", projectId: "unrelated", serviceKey: "__app__", minute: 1235 },
    ]);
    const options = { file, mode: "merge" as const, context: sourceContext,
      selection: { scope: "projects" as const, conflictPolicy: "overwrite" as const },
    };
    const preview = await previewInstanceImport(options);
    expect(preview.blockers).toEqual([]);
    expect(preview.rowsRemoved).toBe(7);
    await expect(importInstance({ ...options, onBeforeCommit: async () => { throw new Error("rollback replacement"); } })).rejects.toThrow("rollback replacement");
    expect(await db.select().from(schema.service).where(eq(schema.service.id, "old_service"))).toHaveLength(1);
    expect(decrypt((await db.select().from(schema.project).where(eq(schema.project.id, "web")))[0]!.cloneTokenEncrypted!)).toBe("destination-token");
    await importInstance(options);
    for (const table of [schema.service, schema.envVar, schema.deployment, schema.serviceDeployment, schema.projectConnection, schema.serverAnalytics]) {
      expect((await db.select().from(table)).some((row) => row.id.startsWith("old_"))).toBe(false);
    }
    expect((await db.select().from(schema.resourceUsage)).map((row) => row.id)).toEqual(["other_usage"]);
    expect((await repos.project.findById("web"))!.activeDeploymentId).toBe("deploy_web");
    expect((await db.select().from(schema.project)).map((row) => row.id).sort()).toEqual(["database", "staging", "unrelated", "web"]);
  });

  it("preserves destination categories excluded from an overwrite", async () => {
    await source();
    const file = await exportFile({ includeEnvironments: false }, false);
    await db.insert(schema.envVar).values({ id: "kept_env", projectId: "web", key: "KEEP", value: encrypt("kept-secret") });
    await db.insert(schema.domain).values({ id: "kept_domain", projectId: "web", hostname: "kept.example.test" });
    await db.insert(schema.resourceUsage).values({ id: "kept_usage", projectId: "web", serviceKey: "__app__", minute: 1235 });
    await importInstance({ file, mode: "merge", context: sourceContext, selection: {
      scope: "projects", conflictPolicy: "overwrite", includeSecrets: false, includeDomains: false, history: [],
    } });
    expect(decrypt((await db.select().from(schema.envVar).where(eq(schema.envVar.id, "kept_env")))[0]!.value)).toBe("kept-secret");
    expect(await db.select().from(schema.domain).where(eq(schema.domain.id, "kept_domain"))).toHaveLength(1);
    expect(await db.select().from(schema.resourceUsage).where(eq(schema.resourceUsage.id, "kept_usage"))).toHaveLength(1);
  });

  it("replaces a selected category even when the source contains no records in it", async () => {
    await source();
    await db.delete(schema.domain).where(eq(schema.domain.id, "domain_web"));
    const file = await exportFile({ history: ["analytics"], includeEnvironments: false }, false);
    expect(file.dump.tables.server_analytics).toEqual([]);
    await db.insert(schema.domain).values({ id: "old_domain", projectId: "web", hostname: "old.example.test" });
    await db.insert(schema.serverAnalytics).values({ id: "old_history", serverId: "source_server", domain: "old.example.test", minute: 1234 });
    await importInstance({ file, mode: "merge", context: sourceContext,
      selection: { scope: "projects", conflictPolicy: "overwrite" },
    });
    expect(await db.select().from(schema.domain)).toHaveLength(0);
    expect(await db.select().from(schema.serverAnalytics)).toHaveLength(0);
  });

  it("refuses to remove a service used by an unselected project without changing destination records", async () => {
    await source();
    const file = await exportFile({ includeEnvironments: false }, false);
    await db.insert(schema.service).values({ id: "shared_service", projectId: "web", name: "shared" });
    await db.insert(schema.projectConnection).values({ id: "other_link", organizationId: "org_source",
      sourceProjectId: "web", sourceServiceId: "shared_service", targetProjectId: "unrelated", envKey: "DATABASE_URL", outputId: "dbUrl",
    });
    await db.update(schema.project).set({ buildCommand: "keep-destination-build" }).where(eq(schema.project.id, "web"));
    const options = { file, mode: "merge" as const, context: sourceContext,
      selection: { scope: "projects" as const, conflictPolicy: "overwrite" as const },
    };
    expect((await previewInstanceImport(options)).blockers.join(" ")).toContain("project_connection still references a service");
    await expect(importInstance(options)).rejects.toThrow("project_connection still references a service");
    expect(await db.select().from(schema.service).where(eq(schema.service.id, "shared_service"))).toHaveLength(1);
    expect((await repos.project.findById("web"))!.buildCommand).toBe("keep-destination-build");
  });

  it("preserves cleared notification credentials and source public settings through instance replacement", async () => {
    await source();
    await db.insert(schema.notificationChannel).values({ id: "channel", userId: "user_source", kind: "webhook", label: "Webhook", config: { url: "https://new.example.test" } });
    const file = await exportInstance({});
    await db.update(schema.notificationChannel).set({ config: { url: "https://old.example.test", hmacSecret: encrypt("removed-key") } }).where(eq(schema.notificationChannel.id, "channel"));
    await importInstance({ file, mode: "wipe" });
    expect((await db.select().from(schema.notificationChannel))[0]!.config).toEqual({ url: "https://new.example.test" });
  });

  it("exports overview traffic and daily analytics using the edge's normalized hostname", async () => {
    await source();
    await db.update(schema.domain).set({ hostname: "www.web.example.test" }).where(eq(schema.domain.id, "domain_web"));
    await db.insert(schema.serverAnalytics).values({
      id: "overview_traffic", serverId: "source_server", domain: "web.example.test",
      minute: 1234, requests: 42,
    });
    await db.insert(schema.serverAnalyticsGeo).values({
      id: "overview_daily", serverId: "source_server", domain: "web.example.test",
      day: "20260927", countries: { EG: 42 }, visitors: 12,
    });
    const file = await exportFile({ history: ["analytics"] }, false);
    expect(file.dump.tables.server_analytics).toEqual([expect.objectContaining({ requests: 42 })]);
    expect(file.dump.tables.server_analytics_geo).toEqual([expect.objectContaining({ visitors: 12 })]);
    await destination();
    await importInstance({ file, mode: "merge", context });
    expect((await db.select().from(schema.serverAnalytics))[0]).toMatchObject({ serverId: "target_server", requests: 42 });
    expect((await db.select().from(schema.serverAnalyticsGeo))[0]).toMatchObject({ serverId: "target_server", visitors: 12 });
  });

  it.each([true, false])("round-trips all values, reuses the same server and remaps targets (password protected: %s)", async (passwordProtected) => {
    await source();
    const file = await exportFile({}, passwordProtected);
    await destination();
    const preview = await previewInstanceImport({ file, context });
    expect(preview.blockers).toEqual([]);
    expect(preview.hasSecrets).toBe(true);
    expect(preview.requiresPassphrase).toBe(passwordProtected);
    expect(preview.servers).toContainEqual(
      expect.objectContaining({ id: "source_server", action: "reuse", targetId: "target_server" }),
    );
    expect(await db.select().from(schema.project)).toHaveLength(0); // preview cannot write
    const result = await importInstance({ file, passphrase: passwordProtected ? password : undefined, mode: "merge", context });
    expect(result.projectsCreated).toBe(3);
    const [project] = await db.select().from(schema.project).where(eq(schema.project.id, "web"));
    expect(project).toMatchObject({
      organizationId: context.organizationId,
      serverId: "target_server",
      activeDeploymentId: "deploy_web",
    });
    expect(decrypt(project!.cloneTokenEncrypted!)).toBe("project-clone-token");
    const [environment] = await db
      .select()
      .from(schema.envVar)
      .where(eq(schema.envVar.id, "env_service"));
    expect(environment!.serviceId).toBe("service_web");
    expect(decrypt(environment!.value)).toBe("service-secret");
    const [storedService] = await db.select().from(schema.service);
    expect(typeof storedService!.environment).toBe("string");
    const service = await repos.service.findById(storedService!.id);
    expect(service!.environment).toEqual({ INLINE_PASSWORD: "inline-secret" });
    expect(service!.advanced).toEqual({
      files: [{ path: "/run/secrets/key", content: "private-file-contents" }],
    });
    const [storedDeployment] = await db.select().from(schema.deployment);
    const deployment = await repos.deployment.findById(storedDeployment!.id);
    expect(deployment!.meta).toMatchObject({
      organizationId: context.organizationId,
      serverId: "target_server",
      composeServices: [{ environment: { PASSWORD: "frozen-compose-secret" } }],
    });
    expect(decrypt((deployment!.envVars as Record<string, string>).API_KEY!)).toBe(
      "snapshot-secret",
    );
    const [server] = await db
      .select()
      .from(schema.servers)
      .where(eq(schema.servers.id, "target_server"));
    expect(decryptSecretField(server!.sshPassword)).toBe("destination-password");
    expect(
      await db.select().from(schema.servers).where(eq(schema.servers.id, "source_server")),
    ).toHaveLength(0);
    const [key] = await db.select().from(schema.githubDeployKey);
    expect(key!.serverId).toBe("target_server");
    expect(decrypt(key!.privateKeyEncrypted)).toBe("repo-private-key");
    const [policy] = await db.select().from(schema.backupPolicy);
    expect(policy!.webhookToken).toBe("backup-trigger-secret");
    expect(policy!.createdBy).toBeNull();
    const [gitSource] = await db.select().from(schema.gitSource);
    expect(gitSource!.isDefault).toBe(true);
    expect(JSON.parse(decryptSecretField(gitSource!.secretsEnc)!)).toMatchObject({
      privateKeyPem: "git-app-private-key",
    });
    const [installation] = await db.select().from(schema.gitInstallation);
    expect(installation).toMatchObject({
      sourceId: "git_source",
      organizationId: context.organizationId,
      userId: context.userId,
    });
  });

  it("skips existing projects by default and overwrites natural matches without dropping destination secrets", async () => {
    await source();
    await db
      .update(schema.project)
      .set({
        compositeRoutes: [
          {
            hostname: "web.example.test",
            isCustomDomain: true,
            rootServiceId: "service_web",
            locations: [{ pathPrefix: "/api", serviceId: "service_web" }],
          },
        ],
      })
      .where(eq(schema.project.id, "web"));
    await db
      .insert(schema.incomingWebhook)
      .values({
        id: "hook",
        organizationId: "org_source",
        projectId: "web",
        name: "Deploy web",
        actionType: "deploy",
        actionConfig: { serviceId: "service_web", serviceIds: ["service_web"] },
        tokenEncrypted: encrypt("hook-token"),
      });
    const file = await exportFile({ includeEnvironments: false, includeLinkedProjects: false });
    await destination();
    await db
      .insert(schema.projectGroup)
      .values({
        id: "existing_group",
        organizationId: context.organizationId,
        name: "Web",
        slug: "web",
      });
    await db
      .insert(schema.project)
      .values({
        id: "existing_web",
        groupId: "existing_group",
        organizationId: context.organizationId,
        name: "Web",
        slug: "web",
        serverId: "target_server",
        buildCommand: "old-build",
        cloneTokenEncrypted: encrypt("destination-token"),
      });
    await db
      .insert(schema.service)
      .values({
        id: "existing_service",
        projectId: "existing_web",
        name: "web",
        environment: { KEEP: "destination-service-secret" },
      });
    await db
      .insert(schema.envVar)
      .values({
        id: "existing_env",
        projectId: "existing_web",
        key: "API_KEY",
        value: encrypt("destination-env-secret"),
      });
    expect(
      (await importInstance({ file, passphrase: password, mode: "merge", context })).rowsRestored,
    ).toBe(0);
    const importSelection: ImportSelection = {
      scope: "projects",
      conflictPolicy: "overwrite",
      includeSecrets: false,
    };
    const updated = await importInstance({
      file,
      mode: "merge",
      context,
      selection: importSelection,
    });
    expect(updated.projectsUpdated).toBe(1);
    const [project] = await db
      .select()
      .from(schema.project)
      .where(eq(schema.project.id, "existing_web"));
    expect(project!.buildCommand).toBe("npm run build");
    expect(decrypt(project!.cloneTokenEncrypted!)).toBe("destination-token");
    const [environment] = await db
      .select()
      .from(schema.envVar)
      .where(eq(schema.envVar.id, "existing_env"));
    expect(decrypt(environment!.value)).toBe("destination-env-secret");
    const [service] = await db
      .select()
      .from(schema.service)
      .where(eq(schema.service.id, "existing_service"));
    expect(service!.environment).toEqual({ KEEP: "destination-service-secret" });
    expect(await db.select().from(schema.project).where(eq(schema.project.id, "web"))).toHaveLength(
      0,
    );
    await importInstance({
      file,
      passphrase: password,
      mode: "merge",
      context,
      selection: { ...importSelection, includeSecrets: true },
    });
    const [replaced] = await db
      .select()
      .from(schema.envVar)
      .where(eq(schema.envVar.id, "existing_env"));
    expect(decrypt(replaced!.value)).toBe("environment-secret");
    const [hook] = await db.select().from(schema.incomingWebhook);
    expect(hook!.actionConfig).toEqual({
      serviceId: "existing_service",
      serviceIds: ["existing_service"],
    });
    const [storedDeployment] = await db.select().from(schema.deployment);
    const deployment = await repos.deployment.findById(storedDeployment!.id);
    expect(deployment!.meta).toMatchObject({
      targetServiceIds: ["existing_service"],
      composeServices: [
        {
          id: "existing_service",
          projectId: "existing_web",
          environment: { serviceId: "service_web" },
        },
      ],
    });
    const [updatedProject] = await db
      .select()
      .from(schema.project)
      .where(eq(schema.project.id, "existing_web"));
    expect(updatedProject!.compositeRoutes).toEqual([
      {
        hostname: "web.example.test",
        isCustomDomain: true,
        rootServiceId: "existing_service",
        locations: [{ pathPrefix: "/api", serviceId: "existing_service" }],
      },
    ]);
  });

  it("reuses a destination Git installation and updates its numeric project references", async () => {
    await source();
    await db
      .update(schema.projectGroup)
      .set({ installationId: 42 })
      .where(eq(schema.projectGroup.id, "group_web"));
    const file = await exportFile();
    await destination();
    await db
      .insert(schema.gitSource)
      .values({
        id: "destination_git",
        organizationId: context.organizationId,
        name: "Connected App",
        appId: 42,
        slug: "connected-app",
        webhookUrl: "https://destination.example.test/api/github/webhook",
        secretsEnc: encryptSecretField("destination-app-secrets")!,
      });
    await db
      .insert(schema.gitInstallation)
      .values({
        id: "destination_install",
        userId: context.userId,
        organizationId: context.organizationId,
        sourceId: "destination_git",
        installationId: 84,
        owner: "owner",
      });
    await importInstance({ file, passphrase: password, mode: "merge", context });
    const [project] = await db.select().from(schema.project).where(eq(schema.project.id, "web"));
    const [group] = await db
      .select()
      .from(schema.projectGroup)
      .where(eq(schema.projectGroup.id, "group_web"));
    expect(project!.installationId).toBe(84);
    expect(group!.installationId).toBe(84);
    expect(await db.select().from(schema.gitInstallation)).toHaveLength(1);
  });

  it("includes historical servers referenced only by sealed deployment snapshots in export and import previews", async () => {
    await source();
    await db
      .insert(schema.servers)
      .values({
        id: "historical_server",
        organizationId: "org_source",
        name: "Previous host",
        sshHost: "203.0.113.30",
      });
    await db
      .insert(schema.deployment)
      .values({
        id: "historical_deployment",
        projectId: "web",
        organizationId: "org_source",
        branch: "main",
        status: "ready",
        meta: {
          organizationId: "org_source",
          serverId: "historical_server",
          deployTarget: "server",
        },
      });
    const file = await exportFile();
    const exportPreview = await previewInstanceExport(selection);
    expect(exportPreview.manifest!.servers.map((server) => server.id)).toContain(
      "historical_server",
    );
    expect(file.dump.tables.servers!.map((server) => server.id)).toContain("historical_server");
    await destination();
    const importPreview = await previewInstanceImport({ file, context });
    expect(importPreview.servers.map((server) => server.id)).toContain("historical_server");
  });

  it("rejects project wipes and wrong passwords before any project is inserted", async () => {
    await source();
    const file = await exportFile();
    await destination();
    await expect(
      importInstance({ file, passphrase: password, mode: "wipe", context }),
    ).rejects.toThrow("cannot wipe");
    await expect(
      importInstance({ file, passphrase: "wrong", mode: "merge", context }),
    ).rejects.toThrow();
    expect(await db.select().from(schema.project)).toHaveLength(0);
  });

  it("requires explicit local-host mapping and clears live runtime bindings on a different host", async () => {
    await source();
    await db
      .update(schema.servers)
      .set({ isLocal: true, sshHost: "127.0.0.1" })
      .where(eq(schema.servers.id, "source_server"));
    await db
      .insert(schema.edgeTargetVerification)
      .values({
        id: "edge_source",
        organizationId: "org_source",
        serverId: "source_server",
        target: "http://source.example.test",
        host: "source.example.test",
        token: "source-edge-proof",
        status: "verified",
      });
    const file = await exportFile();
    await destination();
    expect(file.dump.tables.edge_target_verification).toHaveLength(1);
    const preview = await previewInstanceImport({ file, context });
    expect(preview.blockers.join(" ")).toContain("Choose an existing destination server");
    await importInstance({
      file,
      passphrase: password,
      mode: "merge",
      context,
      selection: { scope: "projects", serverMappings: { source_server: "target_server" } },
    });
    const [project] = await db.select().from(schema.project).where(eq(schema.project.id, "web"));
    expect(project!.activeDeploymentId).toBeNull();
    expect(project!.disabledAt).toBeInstanceOf(Date);
    const [storedDeployment] = await db.select().from(schema.deployment);
    const deployment = await repos.deployment.findById(storedDeployment!.id);
    expect(deployment!.containerId).toBeNull();
    expect(deployment!.meta).toBeNull();
    const [domain] = await db.select().from(schema.domain);
    expect(domain!.verified).toBe(false);
    expect(await db.select().from(schema.edgeTargetVerification)).toHaveLength(0);
    const [policy] = await db.select().from(schema.backupPolicy);
    expect(policy!.enabled).toBe(false);
  });

  it("requires mapping for loopback SSH addresses even when the server is not marked local", async () => {
    await source();
    await db
      .update(schema.servers)
      .set({ isLocal: false, sshHost: "[::1]" })
      .where(eq(schema.servers.id, "source_server"));
    const file = await exportFile();
    await destination();
    await db
      .update(schema.servers)
      .set({ sshHost: "[::1]" })
      .where(eq(schema.servers.id, "target_server"));
    const preview = await previewInstanceImport({ file, context });
    expect(preview.servers).toContainEqual(
      expect.objectContaining({ id: "source_server", action: "map" }),
    );
    expect(preview.blockers.join(" ")).toContain("Choose an existing destination server");
  });

  it("carries control-plane edge proofs for local projects and preserves remote proofs when reusing their host", async () => {
    await source();
    await db.update(schema.project).set({ serverId: null }).where(eq(schema.project.id, "staging"));
    await db.insert(schema.edgeTargetVerification).values([
      {
        id: "edge_local",
        organizationId: "org_source",
        serverId: null,
        target: "http://control.example.test",
        host: "control.example.test",
        token: "local-edge-proof",
        status: "verified",
      },
      {
        id: "edge_remote",
        organizationId: "org_source",
        serverId: "source_server",
        target: "http://remote.example.test",
        host: "remote.example.test",
        token: "remote-edge-proof",
        status: "verified",
      },
    ]);
    const file = await exportFile();
    expect(file.dump.tables.edge_target_verification).toHaveLength(2);
    expect(JSON.stringify(file)).not.toContain("remote-edge-proof");
    await destination();
    await importInstance({
      file,
      passphrase: password,
      mode: "merge",
      context,
      selection: { scope: "projects", serverMappings: { local: "target_server" } },
    });
    const proofs = await db.select().from(schema.edgeTargetVerification);
    expect(proofs).toHaveLength(1);
    expect(proofs[0]).toMatchObject({
      id: "edge_remote",
      serverId: "target_server",
      token: "remote-edge-proof",
      status: "verified",
    });
  });

  it.each(["local", "sftp", "openship_server"])(
    "requires backup verification for imported %s storage that changes location",
    async (kind) => {
      await source();
      await db
        .update(schema.backupDestination)
        .set({
          kind,
          serverId: kind === "openship_server" ? "backup_server" : null,
          endpoint: kind === "local" ? "/source/backups" : null,
          sshHost: kind === "sftp" ? "localhost" : null,
          lastVerifiedAt: new Date(),
        })
        .where(eq(schema.backupDestination.id, "destination"));
      const file = await exportFile();
      await destination();
      const result = await importInstance({
        file,
        passphrase: password,
        mode: "merge",
        context,
        selection: {
          scope: "projects",
          serverMappings: kind === "openship_server" ? { backup_server: "target_server" } : {},
        },
      });
      const [policy] = await db.select().from(schema.backupPolicy);
      const [backupDestination] = await db.select().from(schema.backupDestination);
      const [project] = await db.select().from(schema.project).where(eq(schema.project.id, "web"));
      expect(policy!.enabled).toBe(false);
      expect(backupDestination!.lastVerifiedAt).toBeNull();
      expect(result.warnings!.join(" ")).toContain("Verify backup destination Offsite");
      expect(project!.activeDeploymentId).toBe("deploy_web");
    },
  );

  it.each([true, false])("checks the Cloud account and allows an independent subset (password protected: %s)", async (passwordProtected) => {
    await source();
    await db
      .update(schema.project)
      .set({ serverId: null, cloudWorkspaceId: "cloud-workspace" })
      .where(eq(schema.project.id, "web"));
    vi.mocked(getCloudConnectionStatusForOrg).mockResolvedValue({
      connected: true,
      user: { name: "Source", email: "source@example.test" },
    });
    const file = await exportFile({}, passwordProtected);
    const passphrase = passwordProtected ? password : undefined;
    expect(file.manifest?.cloudAccounts).toContainEqual({
      organizationId: "org_source", email: "source@example.test",
    });
    await destination();
    vi.mocked(getCloudConnectionStatusForOrg).mockResolvedValue({
      connected: true,
      user: { name: "Other", email: "other@example.test" },
    });
    expect((await previewInstanceImport({ file, context })).blockers.join(" ")).toContain(
      "Cloud account mismatch",
    );
    await expect(
      importInstance({ file, passphrase, mode: "merge", context }),
    ).rejects.toThrow("Cloud account mismatch");
    expect(await db.select().from(schema.project)).toHaveLength(0);
    await importInstance({
      file,
      passphrase,
      mode: "merge",
      context,
      selection: { scope: "projects", projectIds: ["staging"] },
    });
    expect((await db.select().from(schema.project)).map((row) => row.id)).toEqual(["staging"]);
    vi.mocked(getCloudConnectionStatusForOrg).mockResolvedValue({
      connected: true,
      user: { name: "Source", email: "source@example.test" },
    });
    const result = await importInstance({ file, passphrase, mode: "merge", context });
    expect(result.projectsCreated).toBe(2);
    expect((await db.select().from(schema.project).where(eq(schema.project.id, "web")))[0]!.cloudWorkspaceId)
      .toBe("cloud-workspace");
  });

  it.each([true, false])("keeps import atomic and cannot apply secrets to unselected rows (password protected: %s)", async (passwordProtected) => {
    await source();
    const file = await exportFile({}, passwordProtected);
    await destination();
    await expect(
      importInstance({
        file,
        passphrase: passwordProtected ? password : undefined,
        mode: "merge",
        context,
        onBeforeCommit: async () => {
          throw new Error("abort-before-commit");
        },
      }),
    ).rejects.toThrow("abort-before-commit");
    expect(await db.select().from(schema.project)).toHaveLength(0);
    expect(await db.select().from(schema.githubDeployKey)).toHaveLength(0);
    const bundle = openTransferSecrets(file.secrets, password)!;
    bundle.entries.push({
      table: "servers",
      id: "target_server",
      column: "sshPassword",
      scheme: "enc1",
      value: "injected-password",
    });
    await importPreparedInstance({ file, secrets: bundle, mode: "merge", context });
    const [server] = await db
      .select()
      .from(schema.servers)
      .where(eq(schema.servers.id, "target_server"));
    expect(decryptSecretField(server!.sshPassword)).toBe("destination-password");
  });

  it("rejects malformed plaintext values before importing any records", async () => {
    await source();
    const file = await exportFile({}, false);
    file.secrets = { encoding: "plaintext", version: 1, entries: [{
      table: "env_var", id: "env_service", column: "value", scheme: "scalar",
    }] };
    await destination();
    await expect(previewInstanceImport({ file, context })).rejects.toThrow("invalid secret value");
    await expect(importInstance({ file, mode: "merge", context })).rejects.toThrow("invalid secret value");
    expect(await db.select().from(schema.project)).toHaveLength(0);
  });

  it.each(["table", "field", "credential"])("rejects an unsupported %s before replacing any destination data", async (kind) => {
    await source();
    const file = await exportInstance({});
    if (kind === "table") file.dump.tables.future_table = [{ id: "future" }];
    if (kind === "field") file.dump.tables.project![0]!.futureSetting = "must-not-disappear";
    if (kind === "credential") {
      file.secrets = { encoding: "plaintext", version: 1, entries: [{
        table: "project", id: "web", column: "futureCredential", scheme: "scalar", value: "must-not-disappear",
      }] };
    }
    await db.update(schema.project).set({ buildCommand: "unchanged" }).where(eq(schema.project.id, "web"));
    await expect(previewInstanceImport({ file, context: sourceContext })).rejects.toThrow(/unsupported.*Update the destination/);
    await expect(importInstance({ file, mode: "wipe" })).rejects.toThrow(/unsupported.*Update the destination/);
    expect((await repos.project.findById("web"))!.buildCommand).toBe("unchanged");
  });

  it("still imports a legacy version 3 plaintext project archive", async () => {
    await source();
    const file = await exportFile({}, false);
    file.envelopeVersion = 3;
    await destination();
    await importInstance({ file, mode: "merge", context });
    expect(decrypt((await db.select().from(schema.envVar).where(eq(schema.envVar.id, "env_web")))[0]!.value)).toBe("environment-secret");
  });

  it("previews a chunked file without consuming it, then imports the selected subset using those chunks", async () => {
    await source();
    const file = await exportFile();
    await destination();
    const bytes = Buffer.from(JSON.stringify(file));
    const upload = await createFileUpload({ ownerUserId: context.userId, size: bytes.length });
    await uploadFileChunk({
      uploadId: upload.uploadId,
      ownerUserId: context.userId,
      index: 0,
      sha256: sha256Hex(bytes),
      readBytes: async () => bytes,
    });
    const options = { scope: "projects" as const, projectIds: ["staging"] };
    const preview = await previewFileUpload({
      uploadId: upload.uploadId,
      ownerUserId: context.userId,
      context,
      selection: options,
    });
    expect(preview.blockers).toEqual([]);
    expect((await getSession(upload.uploadId))!.status).toBe("uploading");
    await expect(
      previewFileUpload({ uploadId: upload.uploadId, ownerUserId: "another-user", context }),
    ).rejects.toThrow("unavailable");
    const result = await finalizeFileUpload({
      uploadId: upload.uploadId,
      ownerUserId: context.userId,
      context,
      selection: options,
      mode: "merge",
      passphrase: password,
    });
    expect(result.projectsCreated).toBe(1);
    expect((await db.select().from(schema.project)).map((row) => row.id)).toEqual(["staging"]);
    expect((await getSession(upload.uploadId))!.status).toBe("complete");
  });

  it.each([false, true])("embeds SSH key files and inherited clone tokens without requiring source-machine paths (legacy sealed: %s)", async (passwordProtected) => {
    await source();
    const dir = await mkdtemp(join(tmpdir(), "openship-project-key-test-"));
    try {
      const keyPath = join(dir, "id_test");
      await writeFile(keyPath, "ssh-file-private-key", { mode: 0o600 });
      await db
        .update(schema.servers)
        .set({ sshPrivateKey: null, sshKeyPath: keyPath })
        .where(eq(schema.servers.id, "source_server"));
      await db
        .update(schema.project)
        .set({ cloneTokenEncrypted: null })
        .where(eq(schema.project.id, "web"));
      await db
        .insert(schema.userSettings)
        .values({
          id: "source_user_settings",
          userId: "user_source",
          cloneTokenAsDefault: true,
          cloneTokenEncrypted: encrypt("inherited-clone-token"),
        });
      const file = await exportFile({}, passwordProtected);
      expect(
        file.dump.tables.servers!.find((row) => row.id === "source_server")!.sshKeyPath,
      ).toBeNull();
      expect(JSON.stringify(file).includes("ssh-file-private-key")).toBe(!passwordProtected);
      await destination(false);
      await importInstance({ file, passphrase: passwordProtected ? password : undefined, mode: "merge", context });
      const [server] = await db
        .select()
        .from(schema.servers)
        .where(eq(schema.servers.id, "source_server"));
      expect(server!.sshKeyPath).toBeNull();
      expect(decryptSecretField(server!.sshPrivateKey)).toBe("ssh-file-private-key");
      const [project] = await db.select().from(schema.project).where(eq(schema.project.id, "web"));
      expect(decrypt(project!.cloneTokenEncrypted!)).toBe("inherited-clone-token");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("imports a selection from a legacy instance archive and blocks domains owned by unselected projects", async () => {
    await source();
    const file = await exportFile();
    file.kind = "openship-instance-export";
    file.envelopeVersion = 1;
    file.dump.scope = { kind: "instance" };
    await destination();
    await db
      .insert(schema.projectGroup)
      .values({
        id: "unrelated_group",
        organizationId: context.organizationId,
        name: "Keep",
        slug: "keep",
      });
    await db
      .insert(schema.project)
      .values({
        id: "keep",
        groupId: "unrelated_group",
        organizationId: context.organizationId,
        name: "Keep",
        slug: "keep",
        serverId: "target_server",
      });
    await db
      .insert(schema.domain)
      .values({ id: "taken_domain", projectId: "keep", hostname: "web.example.test" });
    const options: ImportSelection = {
      scope: "projects",
      projectIds: ["web", "database"],
      conflictPolicy: "overwrite",
    };
    const review = await previewInstanceImport({ file, context, selection: options });
    expect(review.blockers.join(" ")).toContain("already belongs to another project");
    await importInstance({
      file,
      passphrase: password,
      mode: "merge",
      context,
      selection: { ...options, includeDomains: false },
    });
    expect((await db.select().from(schema.project)).map((row) => row.id).sort()).toEqual([
      "database",
      "keep",
      "web",
    ]);
    expect((await db.select().from(schema.domain)).map((row) => row.id)).toEqual(["taken_domain"]);
  });

  it("carries historical analytics server dependencies and matches their natural keys on overwrite", async () => {
    await source();
    await db
      .insert(schema.servers)
      .values({
        id: "old_host",
        organizationId: "org_source",
        name: "Previous host",
        sshHost: "203.0.113.30",
      });
    await db
      .insert(schema.serverAnalytics)
      .values({
        id: "analytics_source",
        serverId: "old_host",
        domain: "web.example.test",
        minute: 1234,
        requests: 19,
      });
    const file = await exportFile({ history: ["analytics"] });
    expect(file.dump.tables.servers!.some((row) => row.id === "old_host")).toBe(true);
    await destination();
    await db
      .insert(schema.servers)
      .values({
        id: "old_host_target",
        organizationId: context.organizationId,
        name: "Previous host",
        sshHost: "203.0.113.30",
      });
    await db
      .insert(schema.serverAnalytics)
      .values({
        id: "analytics_target",
        serverId: "old_host_target",
        domain: "web.example.test",
        minute: 1234,
        requests: 2,
      });
    await importInstance({ file, passphrase: password, mode: "merge", context });
    expect(await db.select().from(schema.serverAnalytics)).toHaveLength(1);
    expect((await db.select().from(schema.serverAnalytics))[0]!.requests).toBe(19);
  });
});
