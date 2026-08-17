import { describe, expect, it } from "vitest";
import { ValidationError } from "@repo/core";
import {
  applyExportScope,
  assertExportSafe,
  exportContainsSecretKeys,
  serializeConnectionConfig,
  serializeMountedRelease,
  serializeProjectConfig,
  serializeReleaseSource,
  serializeRouteConfig,
  serializeServerConfig,
} from "./project-config-export.service";
import type { Domain, Project, Server } from "@repo/db";

function server(overrides: Partial<Server> = {}): Server {
  return {
    id: "srv_1",
    organizationId: "org_1",
    name: "Contabo",
    isLocal: false,
    sshHost: "192.168.1.10",
    sshPort: 22,
    sshUser: "root",
    sshAuthMethod: "key",
    sshPassword: "super-secret",
    sshKeyPath: "/root/.ssh/id_rsa",
    sshPrivateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n",
    sshKeyPassphrase: "passphrase",
    sshJumpHost: null,
    sshArgs: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  } as Server;
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "proj_1",
    organizationId: "org_1",
    groupId: "app_1",
    name: "Dashwood",
    slug: "dashwood",
    environmentName: "Production",
    environmentSlug: "production",
    environmentType: "production",
    isApp: false,
    appTemplateId: null,
    localPath: "/srv/dashwood",
    gitProvider: "github",
    gitOwner: "acme",
    gitRepo: "dashwood",
    gitBranch: "main",
    gitUrl: "https://github.com/acme/dashwood.git",
    installationId: 12,
    cloneTokenEncrypted: "enc1:CLONE_TOKEN",
    cloneTokenSetAt: new Date("2026-01-01"),
    releaseSource: null,
    framework: "nextjs",
    packageManager: "pnpm",
    installCommand: null,
    buildCommand: null,
    outputDirectory: null,
    productionPaths: null,
    rootDirectory: null,
    composePath: null,
    startCommand: null,
    buildImage: null,
    productionMode: "host",
    port: 3000,
    hostPort: 3000,
    serverId: "srv_1",
    internalAlias: null,
    activeDeploymentId: null,
    activeReleaseDeploymentId: null,
    mountedRelease: {
      enabled: false,
      containerPath: "/var/www/html",
    },
    webhookId: 1,
    webhookDomain: null,
    webhookSecret: "whsec_secret",
    autoDeploy: true,
    collectPaths: false,
    favicon: null,
    faviconCheckedAt: null,
    deletedAt: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  } as Project;
}

function domain(overrides: Partial<Domain> = {}): Domain {
  return {
    id: "dom_1",
    ownerType: "project",
    projectId: "proj_1",
    webhookSourceId: null,
    serviceId: null,
    hostname: "dashwood.example.com",
    targetPort: 3000,
    targetPath: null,
    domainType: "custom",
    isPrimary: true,
    redirectTo: null,
    redirectStatus: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  } as Domain;
}

function connection(overrides: Partial<{
  id: string;
  organizationId: string;
  sourceProjectId: string;
  targetProjectId: string;
  outputId: string;
  envKey: string;
  mode: string;
  createdAt: Date;
  updatedAt: Date;
}> = {}) {
  return {
    id: "conn_1",
    organizationId: "org_1",
    sourceProjectId: "proj_db",
    targetProjectId: "proj_1",
    outputId: "dbUrl",
    envKey: "DATABASE_URL",
    mode: "internal",
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  };
}

describe("project config export serializers", () => {
  it("omits SSH secrets and key paths from servers", () => {
    const out = serializeServerConfig(server());
    expect(out).toEqual({
      id: "srv_1",
      name: "Contabo",
      isLocal: false,
      sshHost: "192.168.1.10",
      sshPort: 22,
      sshUser: "root",
      sshAuthMethod: "key",
    });
    expect(JSON.stringify(out)).not.toMatch(/secret|passphrase|id_rsa|BEGIN OPENSSH/i);
    expect(exportContainsSecretKeys(out)).toBe(false);
  });

  it("omits clone tokens, webhook secrets, and env values from projects", () => {
    const out = serializeProjectConfig(project(), [domain()], [connection()]);
    expect(out.gitRepo).toBe("dashwood");
    expect(out.mountedRelease).toEqual({ enabled: false, containerPath: "/var/www/html" });
    expect(out.routes[0]?.hostname).toBe("dashwood.example.com");
    expect(out.connections[0]).toEqual({
      id: "conn_1",
      sourceProjectId: "proj_db",
      targetProjectId: "proj_1",
      outputId: "dbUrl",
      envKey: "DATABASE_URL",
      mode: "internal",
    });
    expect(out).not.toHaveProperty("cloneTokenEncrypted");
    expect(out).not.toHaveProperty("webhookSecret");
    expect(JSON.stringify(out)).not.toContain("enc1:CLONE_TOKEN");
    expect(JSON.stringify(out)).not.toContain("whsec_secret");
    expect(exportContainsSecretKeys(out)).toBe(false);
  });

  it("keeps mounted releases opt-in (enabled is passed through, not forced on)", () => {
    expect(serializeProjectConfig(project(), [], []).mountedRelease?.enabled).toBe(false);
    expect(
      serializeProjectConfig(
        project({ mountedRelease: { enabled: true, containerPath: "/app" } }),
        [],
        [],
      ).mountedRelease?.enabled,
    ).toBe(true);
  });

  it("serializes routes and connections without secret payloads", () => {
    expect(serializeRouteConfig(domain()).hostname).toBe("dashwood.example.com");
    expect(serializeConnectionConfig(connection()).envKey).toBe("DATABASE_URL");
  });

  it("allowlists mountedRelease and releaseSource and drops extra JSONB keys", () => {
    const recipe = serializeMountedRelease({
      enabled: true,
      containerPath: "/app",
      cloneTokenEncrypted: "enc1:NO",
      webhookSecret: "whsec",
      unknown: "drop-me",
    });
    expect(recipe).toEqual({ enabled: true, containerPath: "/app" });
    expect(recipe).not.toHaveProperty("cloneTokenEncrypted");
    expect(recipe).not.toHaveProperty("webhookSecret");
    expect(exportContainsSecretKeys(recipe)).toBe(false);

    const src = serializeReleaseSource({
      mode: "github",
      repo: "acme/dashwood",
      cloneTokenEncrypted: "enc1:NO",
    });
    expect(src).toEqual({ mode: "github", repo: "acme/dashwood" });
    expect(src).not.toHaveProperty("cloneTokenEncrypted");
  });

  it("refuses a payload that still contains a secret key", () => {
    expect(() => assertExportSafe({ sshPassword: "x" })).toThrow(ValidationError);
    expect(() => assertExportSafe({ servers: [{ name: "ok" }] })).not.toThrow();
  });

  it("a scoped token only sees granted projects and the servers they reference", () => {
    const mine = project({ id: "proj_mine", serverId: "srv_1" });
    const other = project({ id: "proj_other", serverId: "srv_2" });
    const unused = server({ id: "srv_2", sshHost: "10.0.0.9", name: "Other" });
    const { projects, servers } = applyExportScope(
      [mine, other],
      [server(), unused],
      new Set(["proj_mine"]),
    );
    expect(projects.map((p) => p.id)).toEqual(["proj_mine"]);
    expect(servers.map((s) => s.id)).toEqual(["srv_1"]);
    expect(JSON.stringify(servers)).not.toContain("10.0.0.9");
  });

  it("an unscoped caller keeps the full project and server set", () => {
    const { projects, servers } = applyExportScope(
      [project(), project({ id: "proj_2", serverId: "srv_2" })],
      [server(), server({ id: "srv_2" })],
      null,
    );
    expect(projects).toHaveLength(2);
    expect(servers).toHaveLength(2);
  });
});
