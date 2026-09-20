import { beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createShip, OperationError, type OwnedShip, type VerifiedIdentity } from "../src/native";

const execute = promisify(execFile);
const key = "native-integration-test-persistent-key-32-bytes";
beforeAll(async () => {
  // Exercise the same Node worker shipped in the npm artifact, with real PGlite.
  await execute("bun", ["run", "build:native"], { cwd: resolve(import.meta.dirname, "../../platform"), maxBuffer: 2 * 1024 * 1024 });
}, 60_000);

describe("owned native platform on Node", () => {
  it("persists operator notices while ordinary scopes only read public announcements", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openship-native-notices-"));
    let identity: VerifiedIdentity | null = null;
    let ship: OwnedShip<string> | undefined;
    const options = {
      instanceId: "notices", stateDirectory: directory,
      storage: { driver: "pglite" as const, dataDir: join(directory, "database") },
      encryptionKey: key, runtime: "bare" as const, routing: "none" as const,
      administration: true, identity: { resolve: async () => identity },
    };
    try {
      ship = await createShip(options);
      const user = await ship.operator!.ensureIdentity({ issuer: "notices", subject: "alice", email: "alice@example.test" });
      identity = { user: user.user, sessionId: "notices" };
      const notice = await ship.operator!.notices.create({ title: "Maintenance", message: "Shared state" });
      await ship.start();
      let scope = await ship.scope({ identity: "verified", organizationId: user.personalOrganizationId });
      expect("operator" in scope).toBe(false);
      expect(Object.keys(scope.notices)).toEqual(["list"]);
      expect((await scope.notices.list()).advisories.map(row => row.id)).toEqual([notice.id]);
      expect((await scope.billing.listPlans({ locale: "ar" })).locale).toBe("ar");
      await expect(scope.billing.getState()).rejects.toMatchObject({ code: "CLOUD_SCOPE_UNAVAILABLE" });
      await ship.close();
      ship = await createShip(options);
      expect(await ship.operator!.notices.listAll()).toEqual([notice]);
      await ship.start();
      await ship.operator!.notices.remove(notice.id);
      await ship.close();
      ship = await createShip({ ...options, administration: false });
      expect(ship.operator).toBeUndefined();
      await ship.start();
      scope = await ship.scope({ identity: "verified", organizationId: user.personalOrganizationId });
      expect(await scope.notices.list()).toEqual({ advisories: [] });
    } finally {
      await ship?.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it("persists server Git configuration without granting tenants access to the host Git identity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openship-native-github-"));
    let identity: VerifiedIdentity | null = null;
    let ship: OwnedShip<string> | undefined;
    const options = {
      instanceId: "github", stateDirectory: directory,
      storage: { driver: "pglite" as const, dataDir: join(directory, "database") },
      encryptionKey: key, runtime: "bare" as const, routing: "none" as const,
      administration: true, identity: { resolve: async () => identity },
    };
    try {
      ship = await createShip(options);
      const alice = await ship.operator!.ensureIdentity({ issuer: "github", subject: "alice", email: "alice@example.test" });
      identity = { user: alice.user, sessionId: "github" };
      await ship.start();
      let scope = await ship.scope({ identity: "verified", organizationId: alice.personalOrganizationId });
      expect((await scope.github.listSources()).data).toEqual([]);
      expect(await scope.github.getHome()).toMatchObject({ repos: [], accounts: [], state: { primary: null } });
      await expect(scope.github.getLocalStatus()).rejects.toMatchObject({ statusCode: 403 });
      const server = await scope.servers.create({ name: "Git target", sshHost: "192.0.2.10", sshUser: "ship" });
      await scope.servers.useGitHubDeployKeys(server.id);
      await expect(scope.servers.generateGitHubKey(server.id)).rejects.toMatchObject({ code: "HOST_EXECUTION_DISABLED" });
      await ship.close();
      ship = await createShip(options);
      await ship.start();
      scope = await ship.scope({ identity: "verified", organizationId: alice.personalOrganizationId });
      expect(await scope.servers.githubStatus(server.id)).toMatchObject({ mode: "ssh-deploy-key", connected: false });
      await scope.servers.disconnectGitHub(server.id);
      expect(await scope.servers.githubStatus(server.id)).toEqual({ mode: null, connected: false, deployKeyCount: 0 });
    } finally { await ship?.close(); await rm(directory, { recursive: true, force: true }); }
  }, 60_000);

  it("persists organization invitations and grants, and applies membership revocation after restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openship-native-permissions-"));
    let identity: VerifiedIdentity | null = null;
    let ship: OwnedShip<string> | undefined;
    const options = {
      instanceId: "permissions", stateDirectory: directory,
      storage: { driver: "pglite" as const, dataDir: join(directory, "database") },
      encryptionKey: key, runtime: "bare" as const, routing: "none" as const,
      administration: true, identity: { resolve: async () => identity },
    };
    try {
      ship = await createShip(options);
      const alice = await ship.operator!.ensureIdentity({ issuer: "permissions", subject: "alice", email: "alice@example.test" });
      const bob = await ship.operator!.ensureIdentity({ issuer: "permissions", subject: "bob", email: "bob@example.test" });
      identity = { user: alice.user, sessionId: "permissions" };
      await ship.start();
      const account = await ship.scope({ identity: "verified", organizationId: alice.personalOrganizationId });
      const team = await account.permissions.createTeamOrg({ name: "SDK team", slug: "sdk-team" });
      let admin = await ship.scope({ identity: "verified", organizationId: team.id });
      const invitation = await admin.permissions.inviteWithGrants({
        email: bob.user.email, role: "restricted", delivery: "link",
        grants: [{ resourceType: "settings", resourceId: "*", permissions: ["read"] }],
      });
      await ship.close();
      ship = await createShip(options);
      await ship.start();
      identity = { user: bob.user, sessionId: "bob" };
      const recipient = await ship.scope({ identity: "verified", organizationId: bob.personalOrganizationId });
      expect(await recipient.permissions.acceptInvitation(invitation.id)).toMatchObject({ organizationId: team.id, materialized: 1 });
      const member = await ship.scope({ identity: "verified", organizationId: team.id });
      expect((await member.permissions.listMembers()).map(row => row.userId)).toEqual([bob.user.id]);
      await expect(member.permissions.setMemberRole(bob.user.id, { role: "owner" })).rejects.toMatchObject({ code: "ORG_ADMIN_REQUIRED" });
      identity = { user: alice.user, sessionId: "permissions" };
      admin = await ship.scope({ identity: "verified", organizationId: team.id });
      expect(await admin.permissions.listGrants({ userId: bob.user.id })).toHaveLength(1);
      await ship.operator!.setMembership({ organizationId: team.id, userId: bob.user.id, role: null });
      await ship.operator!.setMembership({ organizationId: team.id, userId: bob.user.id, role: "restricted" });
      expect(await admin.permissions.listGrants({ userId: bob.user.id })).toEqual([]);
      await admin.permissions.removeMember(bob.user.id);
      identity = { user: bob.user, sessionId: "bob" };
      await expect(member.permissions.orgMeta()).rejects.toMatchObject({ code: "NOT_FOUND" });
    } finally { await ship?.close(); await rm(directory, { recursive: true, force: true }); }
  }, 60_000);

  it("persists notification channels and subscriptions while keeping secrets and users isolated", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openship-native-notifications-"));
    let identity: VerifiedIdentity | null = null;
    let ship: OwnedShip<string> | undefined;
    const options = { instanceId: "notifications", stateDirectory: directory,
      storage: { driver: "pglite" as const, dataDir: join(directory, "database") },
      encryptionKey: key, runtime: "bare" as const, routing: "none" as const, administration: true,
      identity: { resolve: async () => identity },
    };
    try {
      ship = await createShip(options);
      const alice = await ship.operator!.ensureIdentity({ issuer: "notifications", subject: "alice", email: "alice@example.test" });
      const bob = await ship.operator!.ensureIdentity({ issuer: "notifications", subject: "bob", email: "bob@example.test" });
      identity = { user: alice.user, sessionId: "notifications" };
      await ship.start();
      let scope = await ship.scope({ identity: "verified", organizationId: alice.personalOrganizationId });
      const created = await scope.notifications.createChannel({ kind: "webhook", label: "Receiver", config: { url: "https://receiver.example.test/events" } });
      const inbox = await scope.notifications.createChannel({ kind: "in_app", label: "Inbox" });
      // In-app verification has no external send.
      expect(await scope.notifications.testChannel(inbox.channel.id)).toEqual({ ok: true, verified: true });
      const subscription = await scope.notifications.upsertSubscription({ category: "deploy.failed", channelId: inbox.channel.id, enabled: true });
      await scope.settings.setCloneCredentials({ token: "persistent-private-token", asDefault: true });
      await scope.settings.setTransferPreferences({ transferMode: "direct", transferCompression: "zstd" });
      expect(await scope.updates.list()).toEqual([]);
      expect(await scope.updates.scan()).toEqual({ scanned: 0, supported: 0 });
      const project = await scope.projects.create({ name: "Hooks", slug: "hooks", gitProvider: "upload" });
      const hook = await scope.webhooks.create(project.id, { actionType: "deploy", name: "Generated code" });
      const token = await scope.tokens.create({ name: "Generated code", grants: [{ resourceType: "project", resourceId: project.id, permissions: ["read", "write"] }] });
      await ship.close();
      ship = await createShip(options);
      await ship.start();
      scope = await ship.scope({ identity: "verified", organizationId: alice.personalOrganizationId });
      expect(await scope.notifications.listSubscriptions()).toEqual([subscription]);
      expect(await scope.webhooks.list(project.id)).toEqual([hook]);
      expect(await scope.tokens.list()).toContainEqual(expect.objectContaining({ id: token.id, name: "Generated code", scoped: true }));
      await scope.tokens.revoke(token.id);
      expect(await scope.settings.get()).toMatchObject({ cloneToken: { hasToken: true, asDefault: true }, transferMode: "direct", transferCompression: "zstd" });
      const audit = await scope.audit.list({ eventType: "settings.updated" });
      expect(audit.items).toHaveLength(2);
      expect(JSON.stringify(audit)).not.toContain("persistent-private-token");
      const channels = await scope.notifications.listChannels();
      expect(channels).toHaveLength(2);
      expect(JSON.stringify(channels)).not.toContain(created.secret!);
      expect(await scope.notifications.updateChannel(created.channel.id, { config: { url: "https://receiver.example.test/new" } })).not.toHaveProperty("secret");
      identity = { user: alice.user, sessionId: "notifications", credential: { organizationId: alice.personalOrganizationId, readOnly: true } };
      await expect(scope.notifications.removeChannel(inbox.channel.id)).rejects.toMatchObject({ code: "TOKEN_READ_ONLY" });
      identity = { user: bob.user, sessionId: "bob" };
      const other = await ship.scope({ identity: "verified", organizationId: bob.personalOrganizationId });
      expect(await other.notifications.listChannels()).toEqual([]);
      await expect(other.notifications.testChannel(created.channel.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    } finally { await ship?.close(); await rm(directory, { recursive: true, force: true }); }
  }, 60_000);

  it("persists jobs and drains a real accepted command without starting an HTTP server", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openship-native-jobs-"));
    let identity: VerifiedIdentity | null = null;
    let ship: OwnedShip<string> | undefined;
    const options = { instanceId: "jobs", stateDirectory: directory,
      storage: { driver: "pglite" as const, dataDir: join(directory, "database") },
      encryptionKey: key, runtime: "bare" as const, routing: "none" as const,
      policy: { allowHostExecution: true }, administration: true,
      identity: { resolve: async () => identity },
    };
    try {
      ship = await createShip(options);
      const mapped = await ship.operator!.ensureIdentity({ issuer: "jobs", subject: "alice", email: "jobs@example.test", instanceAdmin: true });
      identity = { user: mapped.user, sessionId: "job-session" };
      await ship.start();
      let scope = await ship.scope({ identity: "verified", organizationId: mapped.personalOrganizationId });
      const server = await scope.servers.create({ sshHost: "127.0.0.1", name: "Job host" });
      const job = await scope.jobs.create({ label: "Print", command: "printf sdk-job-ok", serverIds: [server.id], scheduleType: "manual", secrets: { TEST_TOKEN: "native-job-secret" } });
      expect(job.actionConfig?.secrets).toEqual({ TEST_TOKEN: "" });
      await expect(scope.jobs.run(job.key)).rejects.toMatchObject({ code: "JOBS_DISABLED" });
      expect(await scope.jobs.listRuns(job.key)).toEqual([]);
      await ship.close();
      ship = await createShip({ ...options, jobs: true });
      await ship.start();
      scope = await ship.scope({ identity: "verified", organizationId: mapped.personalOrganizationId });
      expect((await scope.jobs.get(job.key)).actionConfig?.command).toBe("printf sdk-job-ok");
      // These maintenance registrations belong to this worker and keep their saved overrides.
      const systemJobs = (await scope.jobs.list()).filter(row => row.actionType === "builtin");
      expect(systemJobs.length).toBeGreaterThan(0);
      for (const row of systemJobs) await scope.jobs.update(row.key, { enabled: false });
      const accepted = await scope.jobs.run(job.key);
      expect(accepted.runId).toEqual(expect.any(String));
      await ship.close();
      ship = await createShip(options);
      await ship.start();
      scope = await ship.scope({ identity: "verified", organizationId: mapped.personalOrganizationId });
      expect(await scope.jobs.getRun(accepted.runId!)).toMatchObject({ status: "success", output: "sdk-job-ok", serverIds: [server.id] });
      expect(await scope.jobs.listRuns(job.key)).toHaveLength(1);
      const events = [];
      for await (const event of scope.jobs.streamRun(accepted.runId!)) events.push(JSON.parse(event.data));
      expect(events.map(event => event.type)).toEqual(["snapshot", "complete"]);
      await scope.jobs.remove(job.key);
      // New aggregate/single runs retain access independently of their deleted definition.
      expect((await scope.jobs.getRun(accepted.runId!)).output).toBe("sdk-job-ok");
    } finally {
      await ship?.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 90_000);

  it("persists backup policies, refuses disabled execution, and drains accepted runs through the retained FSM", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openship-native-backups-"));
    let identity: VerifiedIdentity | null = null;
    let ship: OwnedShip<string> | undefined;
    const root = join(directory, "backups");
    const options = { instanceId: "backups", stateDirectory: directory,
      storage: { driver: "pglite" as const, dataDir: join(directory, "database") },
      encryptionKey: key, runtime: "bare" as const, routing: "none" as const, administration: true,
      environment: { BACKUP_ALLOW_LOCAL_DESTINATION: "true", BACKUP_LOCAL_ROOT: root },
      identity: { resolve: async () => identity },
    };
    try {
      ship = await createShip(options);
      const mapped = await ship.operator!.ensureIdentity({ issuer: "backups", subject: "alice", email: "alice@example.test" });
      identity = { user: mapped.user, sessionId: "backup-session" };
      await ship.start();
      let scope = await ship.scope({ identity: "verified", organizationId: mapped.personalOrganizationId });
      const installed = await scope.apps.install({ templateId: "redis" });
      if (installed.kind !== "template") throw new Error("Expected a project draft");
      const projectId = installed.projectId;
      const destination = await scope.backupDestinations.create({ name: "Local", kind: "local", endpoint: join(root, "local") });
      const [service] = await scope.services.list(projectId);
      expect(service).toBeDefined();
      const policy = await scope.backups.createPolicy(projectId, { destinationId: destination.id, serviceId: service!.id, enableWebhook: true, cronExpression: "0 0 1 1 *" });
      expect(policy).toMatchObject({ retainCount: 7, webhookToken: expect.any(String) });
      await expect(scope.backups.run(policy.id)).rejects.toMatchObject({ code: "JOBS_DISABLED" });
      expect(await scope.backups.listRuns(projectId)).toEqual([]);
      const token = policy.webhookToken;
      const rotated = await scope.backups.updatePolicy(policy.id, { rotateWebhookToken: true });
      expect(rotated.webhookToken).not.toBe(token);
      identity = { ...identity, credential: { organizationId: mapped.personalOrganizationId, readOnly: true } };
      await expect(scope.backups.listPolicies(projectId)).rejects.toMatchObject({ code: "TOKEN_READ_ONLY" });
      await expect(scope.backups.updatePolicy(policy.id, { enabled: false })).rejects.toMatchObject({ code: "TOKEN_READ_ONLY" });
      identity = { user: mapped.user, sessionId: "backup-session" };
      await ship.close();
      ship = await createShip({ ...options, jobs: true });
      await ship.start();
      scope = await ship.scope({ identity: "verified", organizationId: mapped.personalOrganizationId });
      expect(await scope.backups.listPolicies(projectId)).toEqual([rotated]);
      const submitted = await scope.backups.run(policy.id);
      // An undeployed draft is an ordinary failed backup, not a permanently queued job.
      // Close immediately to exercise the acceptance/dispatch/shutdown boundary.
      await ship.close();
      ship = await createShip(options);
      await ship.start();
      scope = await ship.scope({ identity: "verified", organizationId: mapped.personalOrganizationId });
      const outcome = await scope.backups.getRun(submitted.runId);
      expect((await scope.backups.listRuns(projectId)).map(row => row.id)).toEqual([submitted.runId]);
      expect(outcome).toMatchObject({ status: "failed", executionFinishedAt: expect.any(String), errorMessage: expect.any(String) });
      const events = [];
      for await (const event of scope.backups.streamRun(submitted.runId)) events.push(JSON.parse(event.data));
      expect(events.map(event => event.type)).toEqual(["snapshot", "complete"]);
      expect(events[1]).toMatchObject({ status: "failed" });
      expect(await scope.backups.protectRun(submitted.runId)).toMatchObject({ retentionLockedUntil: "2099-12-31T23:59:59.000Z" });
      expect(await scope.backups.protectRun(submitted.runId, { protected: false })).toMatchObject({ retentionLockedUntil: null });
      const other = await ship.operator!.ensureNamespace({ issuer: "backups", key: "other", name: "Other", ownerUserId: mapped.user.id });
      const otherScope = await ship.scope({ identity: "verified", organizationId: other.organizationId });
      await expect(otherScope.backups.getRun(submitted.runId)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(otherScope.backups.listPolicies(projectId)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await scope.backups.removePolicy(policy.id);
      expect(await scope.backups.listPolicies(projectId)).toEqual([]);
    } finally {
      await ship?.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 90_000);

  it("reuses backup destination encryption and local adapter probes with persistent tenant isolation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openship-native-destinations-"));
    let identity: VerifiedIdentity | null = null;
    let ship: OwnedShip<string> | undefined;
    const root = join(directory, "backups");
    const options = { instanceId: "destinations", stateDirectory: directory,
      storage: { driver: "pglite" as const, dataDir: join(directory, "database") },
      encryptionKey: key, runtime: "bare" as const, routing: "none" as const, administration: true,
      environment: { BACKUP_ALLOW_LOCAL_DESTINATION: "true", BACKUP_LOCAL_ROOT: root },
      identity: { resolve: async () => identity },
    };
    try {
      ship = await createShip(options);
      const mapped = await ship.operator!.ensureIdentity({ issuer: "destinations", subject: "alice", email: "alice@example.test" });
      identity = { user: mapped.user, sessionId: "backup-session" };
      await ship.start();
      const scoped = await ship.scope({ identity: "verified", organizationId: mapped.personalOrganizationId });
      const local = await scoped.backupDestinations.create({ name: "Local backups", kind: "local", endpoint: join(root, "local") });
      expect(await scoped.backupDestinations.preflight(local.id)).toMatchObject({ ok: true });
      expect((await scoped.backupDestinations.get(local.id)).lastVerifiedAt).toEqual(expect.any(String));
      expect(await scoped.backupDestinations.usage(local.id)).toMatchObject({ destination: { id: local.id }, policies: [] });
      await expect(scoped.backupDestinations.create({ name: "Outside", kind: "local", endpoint: join(directory, "outside") })).rejects.toMatchObject({ code: "BACKUP_DESTINATION_FAILED" });
      const s3 = await scoped.backupDestinations.create({ name: "Object backups", kind: "s3_compatible", bucket: "backups", accessKeyId: "native-access-key", secretAccessKey: "native-storage-secret" });
      expect(s3).toMatchObject({ hasAccessKeyId: true, hasSecretAccessKey: true });
      expect(JSON.stringify(await scoped.backupDestinations.list())).not.toContain("native-storage-secret");
      expect(await scoped.backupDestinations.update(s3.id, { name: "Renamed" })).toMatchObject({ hasSecretAccessKey: true });
      identity = { ...identity, credential: { organizationId: mapped.personalOrganizationId, readOnly: true } };
      await expect(scoped.backupDestinations.preflight(s3.id)).rejects.toMatchObject({ code: "TOKEN_READ_ONLY" });
      await expect(scoped.backupDestinations.update(s3.id, { name: "Forbidden" })).rejects.toMatchObject({ code: "TOKEN_READ_ONLY" });
      expect((await scoped.backupDestinations.get(s3.id)).name).toBe("Renamed");
      identity = { user: mapped.user, sessionId: "backup-session" };
      const other = await ship.operator!.ensureNamespace({ issuer: "destinations", key: "other", name: "Other", ownerUserId: mapped.user.id });
      const otherScope = await ship.scope({ identity: "verified", organizationId: other.organizationId });
      expect(await otherScope.backupDestinations.list()).toEqual([]);
      await expect(otherScope.backupDestinations.get(s3.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await ship.close();
      ship = await createShip(options);
      await ship.start();
      const reopened = await ship.scope({ identity: "verified", organizationId: mapped.personalOrganizationId });
      expect(await reopened.backupDestinations.get(s3.id)).toMatchObject({ name: "Renamed", hasAccessKeyId: true, hasSecretAccessKey: true });
      expect(await reopened.backupDestinations.update(s3.id, { secretAccessKey: null })).toMatchObject({ hasSecretAccessKey: false, hasAccessKeyId: true });
      await reopened.backupDestinations.remove(s3.id);
      expect((await reopened.backupDestinations.list()).map(row => row.id)).toEqual([local.id]);
    } finally {
      await ship?.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 90_000);

  it("installs custom catalog apps with tenant-scoped settings and protected connection credentials", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openship-native-apps-"));
    let identity: VerifiedIdentity | null = null;
    let ship: OwnedShip<string> | undefined;
    try {
      ship = await createShip({ instanceId: "apps", stateDirectory: directory, storage: { driver: "pglite", dataDir: "memory://" },
        encryptionKey: key, runtime: "bare", routing: "none", administration: true,
        identity: { resolve: async () => identity },
      });
      const mapped = await ship.operator!.ensureIdentity({ issuer: "apps", subject: "alice", email: "alice@example.test" });
      identity = { user: mapped.user, sessionId: "app-session" };
      await ship.start();
      const scope = await ship.scope({ identity: "verified", organizationId: mapped.personalOrganizationId });
      expect((await scope.apps.listCatalog()).some(app => app.id === "redis")).toBe(true);
      const definition = {
        id: "native-custom", name: "Native Custom", description: "Native integration fixture", kind: "template" as const,
        logo: "box", category: "other" as const, verified: true, minResources: { memoryMb: 512 },
        services: [{ name: "app", image: "nginx:1.27", exposedPort: 80, exposed: true }],
        configFields: [{ key: "APP_SECRET", service: "app", label: "Secret", generate: "secret" as const }],
        settings: [{ id: "main", label: "Settings", fields: [
          { key: "APP_SECRET", service: "app", label: "Secret", type: "password" as const, secret: true },
          { key: "APP_NAME", service: "app", label: "Name", type: "text" as const },
        ] }],
        connection: { outputs: [{ id: "secret", label: "Secret", source: "env:app:APP_SECRET", secret: true }] },
      };
      expect(await scope.apps.saveCustom(definition)).toEqual({ appId: definition.id });
      expect((await scope.apps.getCatalogEntry(definition.id)).template).toMatchObject({ verified: false, custom: true });
      expect(await scope.apps.hostFit(definition.id)).toEqual({ minResources: { memoryMb: 512 }, capacity: { cpuCores: 0, memoryMb: 0, source: "unknown" }, fit: { ok: true } });
      const installed = await scope.apps.install({ templateId: definition.id });
      expect(installed.kind).toBe("template");
      if (installed.kind !== "template") throw new Error("Expected an installed project");
      const projectId = installed.projectId;
      expect((await scope.apps.getCatalogEntry(definition.id)).draft?.projectId).toBe(projectId);
      expect((await scope.projects.getAppConnection(projectId)).outputs[0]?.value).toMatch(/^[a-f0-9]{64}$/);
      expect((await scope.projects.getAppSettings(projectId)).values.find(row => row.key === "APP_SECRET")).toMatchObject({ secret: true, value: "", set: true });
      await scope.projects.updateAppSettings(projectId, { changes: [
        { service: "app", key: "APP_NAME", value: "Customer app" }, { service: "app", key: "APP_SECRET", value: "customer-secret" },
      ] });
      await scope.projects.updateAppSettings(projectId, { changes: [{ service: "app", key: "APP_SECRET", value: "" }] });
      expect((await scope.projects.getAppConnection(projectId)).outputs[0]?.value).toBe("customer-secret");
      expect(JSON.stringify(await scope.projects.getAppSettings(projectId))).not.toContain("customer-secret");
      identity = { ...identity, credential: { organizationId: mapped.personalOrganizationId, readOnly: true } };
      await expect(scope.projects.getAppConnection(projectId)).rejects.toMatchObject({ code: "TOKEN_READ_ONLY" });
      await expect(scope.apps.install({ templateId: definition.id })).rejects.toMatchObject({ code: "TOKEN_READ_ONLY" });
      expect((await scope.projects.getAppSettings(projectId)).values.some(row => row.value === "Customer app")).toBe(true);
      identity = { user: mapped.user, sessionId: "app-session" };
      const other = await ship.operator!.ensureNamespace({ issuer: "apps", key: "other", name: "Other", ownerUserId: mapped.user.id });
      const otherScope = await ship.scope({ identity: "verified", organizationId: other.organizationId });
      expect(await otherScope.apps.listCustom()).toEqual([]);
      await expect(otherScope.apps.getCatalogEntry(definition.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(otherScope.projects.getAppConnection(projectId)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await scope.apps.removeCustom(definition.id);
      expect(await scope.apps.listCustom()).toEqual([]);
    } finally {
      await ship?.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 90_000);

  it("isolates concurrent instances and tenants, revalidates membership, and drains independently", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openship-owned-test-"));
    const ambient = { ...process.env };
    const opened: OwnedShip<string>[] = [];
    try {
      const instances = await Promise.all(["first", "second"].map(async instanceId => {
        const identities = new Map<string, VerifiedIdentity>();
        const ship = await createShip({ instanceId, stateDirectory: directory, storage: { driver: "pglite", dataDir: "memory://" },
          encryptionKey: key, runtime: "bare", routing: "none", administration: true,
          identity: { resolve: async (assertion: string) => identities.get(assertion) ?? null },
        });
        opened.push(ship);
        const alice = await ship.operator!.ensureIdentity({ issuer: "host", subject: "alice", email: "alice@example.test" });
        const bob = await ship.operator!.ensureIdentity({ issuer: "host", subject: "bob", email: "bob@example.test" });
        identities.set("alice", { user: alice.user, sessionId: "alice-session" });
        identities.set("bob", { user: bob.user, sessionId: "bob-session" });
        const customer = await ship.operator!.ensureNamespace({ issuer: "host", key: "customer", name: "Customer", ownerUserId: alice.user.id });
        await ship.operator!.setMembership({ organizationId: customer.organizationId, userId: bob.user.id, role: "member" });
        await expect(ship.scope({ identity: "alice", organizationId: "forged-tenant" })).rejects.toMatchObject({ code: "NOT_FOUND" });
        const scope = await ship.scope({ identity: "alice", organizationId: customer.organizationId });
        await expect(scope.projects.list()).rejects.toMatchObject({ code: "PLATFORM_NOT_STARTED" });
        await Promise.all([ship.start(), ship.start()]);
        return { ship, scope, identities, customer, alice, bob };
      }));
      const [first, second] = instances;
      expect(first!.alice.user.id).not.toBe(second!.alice.user.id);
      expect(await first!.scope.system.info()).toMatchObject({ selfHosted: true, productMode: "platform", hostControlEnabled: false });
      expect(await first!.scope.system.getSettings()).toMatchObject({ configured: false, productModeEffective: "platform" });
      await expect(first!.scope.system.updateSettings({ productMode: "mail" })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(first!.scope.system.health()).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(first!.scope.system.browse()).rejects.toMatchObject({ code: "SOURCE_PATH_NOT_ALLOWED" });
      const projects = await Promise.all(instances.map(s => s.scope.projects.create({ name: "same-name", gitProvider: "upload" })));
      expect(projects[0]!.organizationId).not.toBe(projects[1]!.organizationId);
      await expect(first!.scope.projects.get(projects[1]!.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(first!.scope.projects.listEnvVars(projects[1]!.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(first!.scope.deployments.buildAccess({ projectId: projects[0]!.id, buildStrategy: "local" })).rejects.toMatchObject({ code: "HOST_EXECUTION_DISABLED" });
      expect((await first!.scope.deployments.list()).total).toBe(0);

      expect((await first!.scope.analytics.overview(projects[0]!.id)).summary.totalRequests).toBe(0);
      expect(await first!.scope.analytics.dashboard()).toMatchObject({ projects: { total: 1 }, deployments: { total: 0 } });
      expect(await first!.scope.analytics.setPathsCollection(projects[0]!.id, { enabled: true })).toEqual({ enabled: true });
      await expect(first!.scope.analytics.summary(projects[1]!.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect((await first!.scope.issues.list()).issues).toEqual([]);
      expect(await first!.scope.issues.health()).toMatchObject({ workloads: [], watching: false, capabilities: { continuous: false } });
      await expect(first!.scope.issues.rescan()).rejects.toMatchObject({ code: "FORBIDDEN" });

      const projectId = projects[0]!.id;
      const controls = first!.scope.projects;
      const preview = await controls.createEnvironment(projectId, { environmentName: "Preview", environmentSlug: "preview" });
      expect((await controls.listEnvironments(projectId)).map(row => row.id)).toEqual([projectId, preview.id]);
      await controls.mergeEnvVars(projectId, { environment: "production", upserts: [
        { key: "PUBLIC_MODE", value: "first", isSecret: false },
        { key: "PRIVATE_TOKEN", value: "native-secret-value", isSecret: true },
      ], deletes: [] });
      await controls.mergeEnvVars(projectId, { environment: "production", upserts: [
        { key: "PUBLIC_MODE", value: "second", isSecret: false },
      ], deletes: [] });
      const variables = await controls.listEnvVars(projectId, { environment: "production" });
      expect(variables).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: "PUBLIC_MODE", value: "second", isSecret: false }),
        expect.objectContaining({ key: "PRIVATE_TOKEN", isSecret: true }),
      ]));
      expect(JSON.stringify(variables)).not.toContain("native-secret-value");
      const tokenState = await controls.updateCloneToken(projectId, { token: "native-clone-secret" });
      expect(await controls.getCloneToken(projectId)).toEqual(tokenState);
      const configured = await controls.setOptions(projectId, { buildCommand: "npm run build" });
      expect(configured.buildCommand).toBe("npm run build");
      expect(configured).not.toHaveProperty("cloneTokenEncrypted");
      expect(configured).not.toHaveProperty("webhookSecret");
      expect(JSON.stringify(configured)).not.toContain("native-clone-secret");
      const home = await controls.getHome();
      expect(home.projects.map(row => row.id)).toContain(projectId);
      expect(home.otherOrgs).toEqual([]);
      expect(JSON.stringify(home)).not.toContain("native-clone-secret");
      expect(home.projects[0]).not.toHaveProperty("cloneTokenEncrypted");
      expect(home.projects[0]).not.toHaveProperty("webhookSecret");
      expect(await controls.recentServerLogs(projectId)).toEqual({ logs: [] });
      await expect(controls.getServerLogStreamToken(projectId)).rejects.toMatchObject({ code: "NO_DOMAIN_CONFIGURED" });
      await expect(controls.streamServerLogs(projectId)[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: "SERVER_LOG_STREAM_UNAVAILABLE" });
      await expect(controls.streamRuntimeLogs(projectId)[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: "NOT_FOUND" });
      const details = await controls.getInfo(projectId);
      expect(details.environments.map(row => row.id)).toEqual([projectId, preview.id]);
      expect(details.project.options.buildCommand).toBe("npm run build");
      expect(details.project).not.toHaveProperty("cloneTokenEncrypted");
      expect(details.project).not.toHaveProperty("webhookSecret");
      expect(JSON.stringify(details)).not.toContain("native-clone-secret");
      expect(await controls.getGitInfo(projectId)).toMatchObject({ success: false, code: "NO_REPOSITORY" });
      const branchError = await controls.listBranches(projectId).catch(error => error);
      expect(branchError).toBeInstanceOf(OperationError);
      expect(branchError).toMatchObject({ statusCode: 400, details: { success: false, error: "No repository connected" } });
      await expect(controls.setAutoDeploy(projectId, { enabled: true })).rejects.toMatchObject({ statusCode: 400, details: { success: false } });
      expect(await controls.setWebhookDomain(projectId, { domain: null })).toEqual({ success: true, webhook_domain: null });
      expect(await controls.listDeployments(projectId)).toEqual({ data: [], total: 0, page: 1, perPage: 20 });
      expect(await controls.deploymentSession(projectId)).toEqual({ session: null });
      expect(await controls.getPendingActions(projectId)).toEqual({ actions: [] });
      expect(await controls.getCommitStatus(projectId)).toEqual({ supported: false });
      expect(await controls.checkPorts(projectId)).toEqual([]);
      expect(await controls.checkOutput(projectId)).toEqual([]);
      expect(await controls.getRollbackCapacity(projectId)).toMatchObject({ diskFreeBytes: null, diskTotalBytes: null, snapshotSizeBytes: null });
      expect(await controls.listConnections(projectId)).toEqual([]);
      expect(await controls.listConnectionConsumers(projectId)).toEqual([]);
      expect(await controls.getStorage(projectId)).toMatchObject({ binding: null, candidates: [], envPreset: "generic" });
      expect(await controls.unbindStorage(projectId)).toEqual({ removed: false });
      expect(await controls.getEdgeConfig(projectId)).toMatchObject({ reachable: false, hosts: [] });
      const services = first!.scope.services;
      const svc = await services.create(projectId, { name: "sidecar", image: "nginx:alpine", environment: { TOKEN: "compose-private-value" } });
      expect(svc.projectId).toBe(projectId);
      expect(JSON.stringify(svc)).not.toContain("compose-private-value");
      expect(svc).not.toHaveProperty("importedSpec");
      expect(svc).not.toHaveProperty("driftSpec");
      expect((await services.get(projectId, svc.id)).id).toBe(svc.id);
      await expect(services.get(preview.id, svc.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await services.update(projectId, svc.id, { environment: { ADDED: "new", TOKEN: "••••••••" } });
      expect(await services.revealEnv(projectId, svc.id, { keys: ["TOKEN"] })).toEqual({ TOKEN: "compose-private-value" });
      await services.setEnvVars(projectId, svc.id, { environment: "production", vars: [{ key: "KEY", value: "service-scoped-secret", isSecret: true }] });
      const vars = await services.listEnvVars(projectId, svc.id, { environment: "production" });
      expect(JSON.stringify(vars)).not.toContain("service-scoped-secret");
      await services.setEnvVars(projectId, svc.id, { environment: "production", vars: [{ sourceId: vars[0]!.id, key: "RENAMED", value: vars[0]!.value, isSecret: true }] });
      expect(await services.revealEnv(projectId, svc.id, { environment: "production", keys: ["RENAMED"] })).toEqual({ RENAMED: "service-scoped-secret" });
      expect(await services.volumeSizes(projectId, svc.id)).toMatchObject({ success: true, volumes: [] });
      expect((await services.list(projectId)).some(row => row.id === svc.id)).toBe(true);
      await services.remove(projectId, svc.id);
      await expect(services.get(projectId, svc.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
      const domains = first!.scope.domains;
      const added = await domains.create(projectId, { hostname: "native.example.com", externalIngress: true, includeWww: true });
      expect(added.domain).toMatchObject({ projectId, externalIngress: true, verified: false, sslStatus: "none", manualSsl: false });
      expect(added.www).toMatchObject({ hostname: "www.native.example.com" });
      expect(added.records).toEqual({ mode: "external", records: [] });
      expect((await domains.list(projectId)).map(row => row.id)).toContain(added.domain.id);
      await expect(second!.scope.domains.get(added.domain.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(await domains.verify(added.domain.id)).toMatchObject({ verified: true, sslStatus: "external" });
      expect(await first!.scope.deployments.sslStatus({ domain: "native.example.com" })).toMatchObject({ success: true, sslStatus: "external", verified: true });
      await expect(first!.scope.deployments.renewSsl({ domain: "native.example.com", includeWww: true })).rejects.toMatchObject({ code: "HOST_EXECUTION_DISABLED" });
      expect(await domains.get(added.domain.id)).toMatchObject({ verified: true, isPrimary: true });
      const verificationEvents = [];
      for await (const event of domains.verifyStream(added.domain.id)) verificationEvents.push(event.event);
      expect(verificationEvents).toEqual(["session", "log", "complete"]);
      await expect(domains.uploadCert(added.domain.id, { certPem: "cert", keyPem: "private-key" })).rejects.toMatchObject({ code: "HOST_EXECUTION_DISABLED" });
      expect((await first!.scope.dns.listProviders()).some(provider => provider.name === "cloudflare")).toBe(true);
      expect(await first!.scope.dns.listCredentials()).toEqual([]);
      expect((await first!.scope.credentials.listProviders()).map(provider => provider.id)).toContain("docker-registry");
      expect(await first!.scope.credentials.list()).toEqual([]);
      await expect(first!.scope.credentials.get("foreign-credential")).rejects.toMatchObject({ code: "NOT_FOUND" });
      const servers = first!.scope.servers;
      const server = await servers.create({ sshHost: "203.0.113.40", name: "Remote test", sshAuthMethod: "key", sshPrivateKey: "explicit-native-private-key" });
      expect(server).toMatchObject({ name: "Remote test", hasStoredKeyMaterial: true });
      expect(JSON.stringify(server)).not.toContain("explicit-native-private-key");
      expect(server).not.toHaveProperty("sshPrivateKey");
      expect(await servers.list()).toEqual([expect.objectContaining({ id: server.id, projectCount: 0 })]);
      expect(await servers.get(server.id)).toMatchObject({ id: server.id, projectCount: 0 });
      const savedTunnel = await servers.saveTunnel(server.id, { remotePort: 5432 });
      expect(await servers.listTunnels(server.id)).toEqual([savedTunnel]);
      await expect(servers.startTunnel(server.id, { tunnelId: savedTunnel.id })).rejects.toMatchObject({ code: "LOCAL_FORWARDING_DISABLED" });
      expect(await servers.stopTunnel(server.id, { tunnelId: savedTunnel.id })).toMatchObject({ running: false });
      await servers.removeTunnel(server.id, { tunnelId: savedTunnel.id });
      expect(await servers.listTunnels(server.id)).toEqual([]);
      expect(await servers.getInstallSession()).toEqual({ active: false });
      expect(await servers.listContainers(server.id)).toEqual([]);
      expect(await servers.containerApplySession(server.id, { component: "edge" })).toEqual({ active: false });
      expect(await servers.applyAllContainers()).toEqual({ started: [], skipped: [] });
      await expect(servers.applyContainer(server.id, { component: "mail" })[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: "MAIL_SERVER_NOT_PROVISIONED" });
      await expect(servers.containerApplyEvents(server.id, { component: "edge" })[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(servers.respondToInstall({ sessionId: "missing-session", action: "cancel" })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(servers.installEvents({ sessionId: "missing-session" })[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(servers.installComponents("missing-server", { components: ["edge"] })[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(servers.monitor("missing-server")[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(second!.scope.servers.get(server.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(servers.create({ sshHost: "203.0.113.40", sshAuthMethod: "agent" })).rejects.toMatchObject({ code: "HOST_EXECUTION_DISABLED" });
      await expect(servers.update(server.id, { sshPrivateKey: null, sshKeyPath: "/root/.ssh/id_ed25519" })).rejects.toMatchObject({ code: "HOST_EXECUTION_DISABLED" });
      expect(await servers.update(server.id, { name: "Renamed" })).toMatchObject({ name: "Renamed", hasStoredKeyMaterial: true });
      expect(await servers.remove(server.id)).toEqual({ ok: true, serverRemoved: true, destroyOnSource: false, workloads: [], removed: 0 });
      await expect(servers.get(server.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(await first!.scope.dns.verifyZone({ hostname: "native.example.com" })).toMatchObject({ matched: false, status: "none" });
      const rule = await controls.createRouteRule(projectId, { domainId: added.domain.id, pathPrefix: " api ", spec: { rateLimit: { rps: 10.9, burst: 20.2 }, access: { methods: ["get", "GET", "bogus"] } } });
      expect(rule).toMatchObject({ projectId, pathPrefix: "/api", enabled: true, spec: { rateLimit: { rps: 10, burst: 20, key: "ip" }, access: { methods: ["GET"] } } });
      await expect(controls.updateRouteRule(preview.id, { ruleId: rule.id, enabled: false })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await controls.removeRouteRule(preview.id, rule.id);
      expect((await controls.listRouteRules(projectId)).map(row => row.id)).toContain(rule.id);
      expect(await controls.updateRouteRule(projectId, { ruleId: rule.id, enabled: false })).toMatchObject({ enabled: false });
      await controls.removeRouteRule(projectId, rule.id);
      expect(await controls.listRouteRules(projectId)).toEqual([]);
      expect(await controls.getIncidents(projectId)).toEqual({ open: [], resolved: [], historyDays: 30, serverUnreachable: null, watching: false });
      await expect(controls.bindStorage(projectId, { bucket: "uploads", provider: "custom" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      await expect(controls.createConnection(projectId, { sourceProjectId: projects[1]!.id, outputId: "url", envKey: "DATABASE_URL" })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(controls.clearBuildCache(projectId)).rejects.toMatchObject({ code: "FORBIDDEN" });
      await first!.ship.operator!.ensureIdentity({ issuer: "host", subject: "alice", email: "alice@example.test", instanceAdmin: true });
      await expect(controls.clearBuildCache(projectId)).rejects.toMatchObject({ code: "FORBIDDEN" });
      const administrator = await first!.ship.operator!.ensureIdentity({ issuer: "host", subject: "administrator", email: "administrator@example.test", instanceAdmin: true });
      first!.identities.set("administrator", { user: administrator.user, sessionId: "admin-session" });
      await first!.ship.operator!.setMembership({ organizationId: first!.customer.organizationId, userId: administrator.user.id, role: "admin" });
      const adminScope = await first!.ship.scope({ identity: "administrator", organizationId: first!.customer.organizationId });
      await expect(adminScope.projects.clearBuildCache(projectId)).rejects.toMatchObject({ code: "HOST_EXECUTION_DISABLED" });
      expect(await adminScope.system.health()).toMatchObject({ db: { driver: "pglite", ok: true }, hostChannel: { ok: false, state: "disabled" } });
      await expect(adminScope.system.listUntrackedEdgeSites()).rejects.toMatchObject({ code: "HOST_EXECUTION_DISABLED" });
      await adminScope.system.updateSettings({ productMode: "mail" });
      expect(await first!.scope.system.info()).toMatchObject({ productMode: "mail" });
      expect(await second!.scope.system.info()).toMatchObject({ productMode: "platform" });
      await adminScope.system.updateEmailSettings({ host: "smtp.example.test", user: "native", password: "private-native-smtp" });
      const emailSettings = await first!.scope.system.getEmailSettings();
      expect(emailSettings).toMatchObject({ configured: true, hasPassword: true, host: "smtp.example.test" });
      expect(JSON.stringify(emailSettings)).not.toContain("private-native-smtp");
      expect(await second!.scope.system.getEmailSettings()).toMatchObject({ configured: false, hasPassword: false });

      const disposable = await controls.create({ name: "disposable", gitProvider: "upload" });
      await expect(controls.remove(disposable.id, { recordOnly: true, wipeVolumes: true })).rejects.toMatchObject({ code: "INVALID_DELETE_OPTIONS" });
      expect(await controls.get(disposable.id)).toMatchObject({ id: disposable.id });
      expect(await controls.remove(disposable.id)).toMatchObject({ ok: true, message: "deleted" });
      await expect(controls.get(disposable.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(await controls.updateCloneToken(projectId, { token: null })).toEqual({ hasToken: false, setAt: null });
      expect(await controls.setBranch(projectId, { branch: "release" })).toEqual({ success: true, branch: "release" });
      const resources = await controls.updateResources(projectId, { production: { cpuCores: 0.25, memoryMb: 128, diskMb: 128 } });
      expect(resources.production).toEqual({ cpuCores: 0.25, memoryMb: 128, diskMb: 128 });
      await controls.setSleepMode(projectId, { sleep_mode: "always_on" });
      expect((await controls.getResources(projectId)).sleepMode).toBe("always_on");
      const bobScope = await first!.ship.scope({ identity: "bob", organizationId: first!.customer.organizationId });
      await expect(bobScope.credentials.create({ provider: "docker-registry", name: "Not an admin", values: { secret: "value" } })).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
      await first!.ship.operator!.setMembership({ organizationId: first!.customer.organizationId, userId: first!.bob.user.id, role: null });
      await expect(bobScope.projects.get(projects[0]!.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(bobScope.projects.setBranch(projectId, { branch: "forbidden" })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(bobScope.projects.remove(projectId)).rejects.toMatchObject({ code: "NOT_FOUND" });
      first!.identities.delete("alice");
      await expect(first!.scope.projects.list()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      expect({ ...process.env }).toEqual(ambient);
      await first!.ship.close();
      expect((await second!.scope.projects.list()).data).toHaveLength(1);
      await expect(first!.ship.start()).rejects.toMatchObject({ code: "PLATFORM_CLOSED" });
    } finally {
      await Promise.all(opened.map(ship => ship.close()));
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it("prepares and imports allowed local source through the shared scanner and permission policy", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openship-local-import-"));
    const source = join(directory, "source");
    await mkdir(source);
    await writeFile(join(source, "index.html"), "<h1>Local import</h1>");
    await writeFile(join(directory, "outside.txt"), "private-host-content");
    let identity: VerifiedIdentity | null = null;
    const ship = await createShip({ instanceId: "local-import", stateDirectory: directory,
      storage: { driver: "pglite", dataDir: "memory://" }, encryptionKey: key, runtime: "bare", routing: "none",
      policy: { sourceRoots: [source] }, administration: true, identity: { resolve: async () => identity },
    });
    try {
      const mapped = await ship.operator!.ensureIdentity({ issuer: "host", subject: "local-owner", email: "local@example.test" });
      identity = { user: mapped.user, sessionId: "local-session" };
      await ship.start();
      const { projects, system, deployments, tokens, sources } = await ship.scope({ identity: "verified", organizationId: mapped.personalOrganizationId });
      expect(await system.browse()).toEqual({ path: await realpath(source), directories: [] });
      await expect(system.browse({ path: directory })).rejects.toMatchObject({ code: "SOURCE_PATH_NOT_ALLOWED" });
      expect(await deployments.prepare({ source: "local", path: source })).toMatchObject({ stack: "static", repository: { name: "source" } });
      await expect(deployments.prepare({ source: "local", path: directory })).rejects.toMatchObject({ code: "SOURCE_PATH_NOT_ALLOWED" });
      expect(await projects.scanLocal({ path: source })).toMatchObject({ success: true, path: source, stack: "static" });
      const imported = await projects.importLocal({ name: "imported", localPath: source });
      expect(imported).toMatchObject({ gitProvider: "local", localPath: await realpath(source) });
      expect((await projects.listLocal()).projects.map(project => project.id)).toEqual([imported.id]);
      await expect(projects.importLocal({ name: "forbidden", localPath: directory })).rejects.toMatchObject({ code: "SOURCE_PATH_NOT_ALLOWED" });
      const token = await tokens.create({ name: "Project writer", grants: [{ resourceType: "project", resourceId: imported.id, permissions: ["write"] }] });
      const ownerIdentity = identity;
      identity = { ...identity, tokenScope: { tokenId: token.id }, credential: { organizationId: mapped.personalOrganizationId, readOnly: false } };
      const tokenScope = await ship.scope({ identity: "project-token", organizationId: mapped.personalOrganizationId });
      await expect(tokenScope.deployments.prepare({ source: "local", path: source })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(tokenScope.deployments.prepare({ source: "local", path: source, includeEnv: true })).rejects.toMatchObject({ code: "NOT_FOUND" });
      identity = ownerIdentity;

      // First Compose import: no Compose service row or upload session exists.
      // Exercise the real parser, native worker and editable scan together.
      await mkdir(join(source, "deploy"));
      await writeFile(join(source, "deploy", ".env"), "PASSWORD=from-dotenv\n");
      await writeFile(join(source, "deploy", "stack.yml"), [
        "services:", "  db:", "    image: postgres:16", "    environment:",
        "      POSTGRES_PASSWORD: ${PASSWORD}", "      POSTGRES_DB: app", "      EMPTY: ''",
        "  worker:", "    image: node:22", "    environment:", "      API_TOKEN: sibling-secret",
        "    build:", "      context: .", "      args:", "        TOKEN: native-build-secret", "        INHERITED:", "        EMPTY: ''",
      ].join("\n"));
      const preparedSource = { source: "local" as const, path: source, composePath: "deploy/stack.yml", env: { PASSWORD: "typed-override" } };
      const preview = await deployments.prepare(preparedSource);
      expect(preview).toMatchObject({ services: [{ name: "db", environment: { POSTGRES_PASSWORD: "••••••••", POSTGRES_DB: "••••••••", EMPTY: "" } }, { name: "worker", buildArgs: { TOKEN: "••••••••", INHERITED: null, EMPTY: "" } }] });
      expect(JSON.stringify(preview)).not.toContain("typed-override");
      expect(JSON.stringify(preview)).not.toContain("native-build-secret");
      expect(await deployments.prepare({ ...preparedSource, includeEnv: true })).toMatchObject({
        services: [
          { name: "db", environment: { POSTGRES_PASSWORD: "typed-override", POSTGRES_DB: "app", EMPTY: "" } },
          { name: "worker", environment: { API_TOKEN: "sibling-secret" }, buildArgs: { TOKEN: "native-build-secret", INHERITED: null, EMPTY: "" } },
        ],
      });
      expect(await deployments.prepare({ ...preparedSource, env: {}, includeEnv: true })).toMatchObject({ services: [
        { name: "db", environment: { POSTGRES_PASSWORD: "from-dotenv" } }, { name: "worker" },
      ] });
      await expect(deployments.prepare({ ...preparedSource, path: directory, includeEnv: true })).rejects.toMatchObject({ code: "SOURCE_PATH_NOT_ALLOWED" });

      const compose = "services:\n  db:\n    image: postgres:16\n    environment:\n      POSTGRES_PASSWORD: ${PASSWORD}\n    build:\n      context: .\n      args:\n        TOKEN: staged-build-secret\n";
      await writeFile(join(source, "docker-compose.yml"), compose);
      await writeFile(join(source, ".env"), "PASSWORD=local-scan-password\n");
      expect(await projects.scanLocal({ path: source, includeEnv: true })).toMatchObject({
        services: [{ name: "db", environment: { POSTGRES_PASSWORD: "local-scan-password" }, buildArgs: { TOKEN: "staged-build-secret" } }],
      });
      const staged = await sources.stage({ source: { type: "files", files: {
        "docker-compose.yml": compose, ".env": "PASSWORD=uploaded-password\n",
      } } });
      expect(JSON.stringify(await sources.scan(staged.sessionId))).not.toContain("uploaded-password");
      expect(await sources.scan(staged.sessionId)).toMatchObject({ services: [{ buildArgs: { TOKEN: "••••••••" } }] });
      expect(await sources.scan(staged.sessionId, { includeEnv: true })).toMatchObject({
        services: [{ name: "db", environment: { POSTGRES_PASSWORD: "uploaded-password" }, buildArgs: { TOKEN: "staged-build-secret" } }],
      });
      await symlink(join(directory, "outside.txt"), join(source, "escape.txt"));
      await expect(system.browse({ path: join(source, "escape.txt") })).rejects.toMatchObject({ code: "SOURCE_PATH_NOT_ALLOWED" });
      await expect(projects.scanLocal({ path: source })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      expect((await projects.list()).total).toBe(1);
    } finally {
      await ship.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it("persists external mappings, refuses another key, releases failed initialization, and verifies migrations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openship-persistence-test-"));
    const options = { instanceId: "persistent", stateDirectory: directory, storage: { driver: "pglite" as const, dataDir: join(directory, "database") },
      encryptionKey: key, runtime: "bare" as const, routing: "none" as const, administration: true, identity: { resolve: async () => null },
    };
    let ship: OwnedShip<unknown> | undefined;
    try {
      ship = await createShip(options);
      const identity = await ship.operator!.ensureIdentity({ issuer: "host", subject: "alice", email: "alice@example.test" });
      await expect(ship.operator!.ensureIdentity({ issuer: "another", subject: "alice", email: "alice@example.test" })).rejects.toMatchObject({ code: "CONFLICT" });
      await ship.close();
      ship = undefined;
      // Keep ownership even if the expected rejection regresses, so cleanup
      // does not leave a worker holding the database lock after an assertion.
      await expect(createShip({ ...options, encryptionKey: key + "wrong" }).then(opened => {
        ship = opened;
        return opened;
      })).rejects.toMatchObject({ code: "INSTALLATION_MISMATCH" });
      ship = await createShip({ ...options, storage: { ...options.storage, migrations: "verify" } });
      expect((await ship.operator!.resolveIdentity({ issuer: "host", subject: "alice" }))?.user.id).toBe(identity.user.id);
      expect((await ship.operator!.ensureIdentity({ issuer: "host", subject: "alice", email: "alice@example.test", instanceAdmin: true })).user.id).toBe(identity.user.id);
    } finally {
      await ship?.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it("deploys generated code through the real pipeline and keeps artifacts inside its owned directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openship-generated-test-"));
    let identity: VerifiedIdentity | null = null;
    const ship = await createShip({ instanceId: "generated", stateDirectory: directory, storage: { driver: "pglite", dataDir: "memory://" },
      encryptionKey: key, runtime: "bare", routing: "none", policy: { allowHostExecution: true }, administration: true,
      identity: { resolve: async () => identity },
    });
    try {
      const mapped = await ship.operator!.ensureIdentity({ issuer: "host", subject: "app", email: "app@example.test" });
      identity = { user: mapped.user, sessionId: "host-session" };
      await ship.start();
      const scope = await ship.scope({ identity: "verified", organizationId: mapped.personalOrganizationId });
      await expect(scope.sources.stage({ source: { type: "directory", path: directory } })).rejects.toMatchObject({ code: "SOURCE_PATH_NOT_ALLOWED" });
      await expect(scope.sources.stage({ source: { type: "files", files: { "../escape": "bad" } } })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      const result = await scope.deploy({ name: "generated-app", source: { type: "files", files: { "index.html": "<h1>Generated code</h1>", "dist/asset.txt": "keep built assets" } } });
      const outcome = await scope.deployment(result.deployment_id).wait({ timeoutMs: 30_000, pollIntervalMs: 100 });
      expect(outcome).toMatchObject({ success: true, status: "ready" });
      const row = await scope.deployments.get(result.deployment_id);
      const artifact = join(directory, "generated/workloads/static/releases", result.deployment_id);
      expect(row.containerId).toBe(artifact);
      expect(await readFile(join(artifact, "index.html"), "utf8")).toBe("<h1>Generated code</h1>");
      expect(await readFile(join(artifact, "dist/asset.txt"), "utf8")).toBe("keep built assets");
      const draining = ship.close();
      await draining;
      await expect(scope.projects.list()).rejects.toMatchObject({ code: "PLATFORM_CLOSED" });
    } finally {
      await ship.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
