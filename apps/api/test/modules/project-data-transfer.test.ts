import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, eq, schema, sql, repos } from "@repo/db";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
import { openSecretBundle } from "../../src/modules/system/data-transfer/passphrase-crypto";
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
async function exportFile(overrides: Partial<ExportSelection> = {}): Promise<DataTransferFile> {
  return JSON.parse(
    JSON.stringify(
      await exportInstance({ passphrase: password, selection: { ...selection, ...overrides } }),
    ),
  );
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

  it("exports all environments, linked apps, backup parents and repo keys without unrelated projects or plaintext secrets", async () => {
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
    const secrets = openSecretBundle(file.secrets!, password);
    expect(secrets.entries).toContainEqual(
      expect.objectContaining({
        table: "service",
        column: "environment",
        json: { INLINE_PASSWORD: "inline-secret" },
      }),
    );
  });

  it("round-trips into another workspace, reuses the same server, remaps snapshot targets, and restores every secret transactionally", async () => {
    await source();
    const file = await exportFile();
    await destination();
    const preview = await previewInstanceImport({ file, context });
    expect(preview.blockers).toEqual([]);
    expect(preview.servers).toContainEqual(
      expect.objectContaining({ id: "source_server", action: "reuse", targetId: "target_server" }),
    );
    expect(await db.select().from(schema.project)).toHaveLength(0); // preview cannot write
    const result = await importInstance({ file, passphrase: password, mode: "merge", context });
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

  it("checks the destination cloud account and allows an independent environment subset", async () => {
    await source();
    await db
      .update(schema.project)
      .set({ serverId: null, cloudWorkspaceId: "cloud-workspace" })
      .where(eq(schema.project.id, "web"));
    vi.mocked(getCloudConnectionStatusForOrg).mockResolvedValue({
      connected: true,
      user: { name: "Source", email: "source@example.test" },
    });
    const file = await exportFile();
    await destination();
    vi.mocked(getCloudConnectionStatusForOrg).mockResolvedValue({
      connected: true,
      user: { name: "Other", email: "other@example.test" },
    });
    expect((await previewInstanceImport({ file, context })).blockers.join(" ")).toContain(
      "Cloud account mismatch",
    );
    await expect(
      importInstance({ file, passphrase: password, mode: "merge", context }),
    ).rejects.toThrow("Cloud account mismatch");
    expect(await db.select().from(schema.project)).toHaveLength(0);
    await importInstance({
      file,
      passphrase: password,
      mode: "merge",
      context,
      selection: { scope: "projects", projectIds: ["staging"] },
    });
    expect((await db.select().from(schema.project)).map((row) => row.id)).toEqual(["staging"]);
  });

  it("keeps the complete import atomic and cannot apply a secret to an unselected row", async () => {
    await source();
    const file = await exportFile();
    await destination();
    await expect(
      importInstance({
        file,
        passphrase: password,
        mode: "merge",
        context,
        onBeforeCommit: async () => {
          throw new Error("abort-before-commit");
        },
      }),
    ).rejects.toThrow("abort-before-commit");
    expect(await db.select().from(schema.project)).toHaveLength(0);
    expect(await db.select().from(schema.githubDeployKey)).toHaveLength(0);
    const bundle = openSecretBundle(file.secrets!, password);
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

  it("embeds SSH key files and inherited clone tokens without requiring source-machine paths at the destination", async () => {
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
      const file = await exportFile();
      expect(
        file.dump.tables.servers!.find((row) => row.id === "source_server")!.sshKeyPath,
      ).toBeNull();
      expect(JSON.stringify(file)).not.toContain("ssh-file-private-key");
      await destination(false);
      await importInstance({ file, passphrase: password, mode: "merge", context });
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
