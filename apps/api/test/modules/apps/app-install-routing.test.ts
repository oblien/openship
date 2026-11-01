import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * App install must persist EXACTLY the routing the operator chose — never a
 * fabricated free subdomain. The installer used to seed one `domainType:"free"`
 * endpoint per templated route, so a custom-domain (or port-only) install landed
 * on *.opsh.io routes the user never asked for and then 403'd when the wizard
 * tried to correct them after the fact.
 */

const {
  createProjectMock,
  createServiceMock,
  updateServiceMock,
  setEnvMock,
  requireCloudMock,
  draftMock,
  listServicesMock,
} = vi.hoisted(() => ({
  createProjectMock: vi.fn(),
  createServiceMock: vi.fn(),
  updateServiceMock: vi.fn(),
  setEnvMock: vi.fn(),
  requireCloudMock: vi.fn(),
  draftMock: vi.fn(),
  listServicesMock: vi.fn(),
}));

// Exercise the installer that introduces catalog entrypoint overrides.
vi.mock("@repo/platform/engine/lib/release-dist", () => ({ readApiVersion: () => "0.9.2" }));

vi.mock("@repo/db", () => ({
  repos: {
    project: {
      findDraftByAppTemplate: draftMock,
      // installApp now ends in `ensureGeneratedAppSecrets`; nothing here asserts on it.
      getEnvMap: async () => ({}),
      mergeEnvVars: async () => {},
    },
    service: {
      listByProject: listServicesMock,
      seedDraftAppResourceDefaults: async () => [],
    },
    customAppTemplate: {
      findByAppId: async () => undefined,
      listByOrg: async () => [],
    },
  },
}));

vi.mock("@repo/platform/engine/modules/projects/project-crud.service", () => ({
  createProject: createProjectMock,
}));

vi.mock("@repo/platform/engine/modules/services/service.service", () => ({
  createService: createServiceMock,
  updateService: updateServiceMock,
  setServiceEnvVars: setEnvMock,
}));

vi.mock("@repo/platform/engine/lib/cloud/require-cloud", () => ({
  requireCloud: requireCloudMock,
}));

vi.mock("@repo/platform/engine/lib/cloud-workspace-scope", () => ({
  workspaceForServer: async () => ({ workspace: { id: "cloud-workspace" }, server: { id: "cloud-server" } }),
}));

import {
  installApp,
  installServicePorts,
  planInstallRouting,
  serviceRoutingPatch,
  type InstallAppRoute,
} from "@repo/platform/engine/modules/apps/app-install.service";
import { buildPublicUrlLookup, getAppTemplate, servicePortPairs } from "@repo/core";
import {
  mergeServiceRoutingPatch,
  type StoredServiceRouting,
} from "@repo/platform/engine/lib/public-endpoints";
import type { RequestContext } from "../../../src/lib/request-context";

const ctx = { organizationId: "org1", userId: "u1" } as RequestContext;

/** The createService payload for one service name. */
const payloadFor = (name: string) =>
  createServiceMock.mock.calls.find((c) => c[2]?.name === name)?.[2] as
    | {
        exposed: boolean;
        ports: string[];
        domainType?: "free" | "custom";
        publicEndpoints: Array<{
          port: number;
          domainType: "free" | "custom";
          domain?: string;
          customDomain?: string;
        }>;
      }
    | undefined;

const install = (routes?: InstallAppRoute[]) =>
  installApp(ctx, { templateId: "convex", name: "Convex", routes });

beforeEach(() => {
  vi.clearAllMocks();
  draftMock.mockResolvedValue(undefined);
  listServicesMock.mockResolvedValue([
    { id: "svc-backend", name: "backend" },
    { id: "svc-dashboard", name: "dashboard" },
  ]);
  createProjectMock.mockResolvedValue({ id: "p1", slug: "convex", name: "Convex" });
  createServiceMock.mockResolvedValue({ id: "svc" });
  updateServiceMock.mockResolvedValue(undefined);
  setEnvMock.mockResolvedValue(undefined);
  requireCloudMock.mockResolvedValue(undefined);
  // The catalog overlay refresh is fire-and-forget; keep it off the network.
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
});

it("installs generic Cloud webmail with encrypted client secrets and no managed-mail service", async () => {
  listServicesMock.mockResolvedValue([{ id: "svc-webmail", name: "webmail" }]);
  await installApp(ctx, {
    templateId: "webmail",
    serverId: "cloud-server",
    deployTarget: "cloud",
    routes: [{ service: "webmail", port: 4080, mode: "free" }],
  });
  expect(createServiceMock).toHaveBeenCalledOnce();
  expect(createServiceMock.mock.calls[0]?.[2]).toMatchObject({
    name: "webmail", image: "ghcr.io/oblien/openship-webmail:latest",
  });
  const vars = setEnvMock.mock.calls.find(call => call[2] === "svc-webmail")?.[3].vars;
  for (const key of ["SESSION_ENCRYPTION_KEY", "BRANDING_ADMIN_TOKEN"]) {
    expect(vars).toContainEqual({ key, isSecret: true, value: expect.stringMatching(/^[a-f0-9]{64}$/) });
  }
});

it.each(["self-hosted", "cloud"] as const)(
  "installs WordPress from its official image with runtime setup and encrypted credentials (%s)",
  async (mode) => {
    listServicesMock.mockResolvedValue([
      { id: "svc-wordpress", name: "wordpress" },
      { id: "svc-wordpress-db", name: "wordpress-db" },
    ]);
    await installApp(ctx, {
      templateId: "wordpress",
      ...(mode === "cloud" ? { serverId: "cloud-server", deployTarget: "cloud" as const } : {}),
      config: {
        OPENSHIP_ADMIN_EMAIL: "owner@example.com",
        OPENSHIP_SITE_TITLE: "Our site",
        OPENSHIP_ADMIN_USER: "owner",
      },
      routes: [
        { service: "wordpress", port: 80, mode: "custom", customDomain: "site.example.com" },
      ],
    });
    const writes = (id: string) =>
      setEnvMock.mock.calls.find((call) => call[2] === id)?.[3].vars as Array<{
        key: string;
        value: string;
        isSecret: boolean;
      }>;
    const wordpress = writes("svc-wordpress");
    expect(wordpress).toEqual(
      expect.arrayContaining([
        { key: "OPENSHIP_ADMIN_EMAIL", value: "owner@example.com", isSecret: false },
        { key: "OPENSHIP_SITE_TITLE", value: "Our site", isSecret: false },
        { key: "OPENSHIP_ADMIN_USER", value: "owner", isSecret: false },
      ]),
    );
    const dbPassword = writes("svc-wordpress-db").find(
      (field) => field.key === "MARIADB_PASSWORD",
    )!;
    expect(wordpress.find((field) => field.key === "WORDPRESS_DB_PASSWORD")).toMatchObject({
      value: dbPassword.value,
      isSecret: true,
    });
    expect(dbPassword.isSecret).toBe(true);
    expect(wordpress.find((field) => field.key === "OPENSHIP_ADMIN_PASSWORD")).toMatchObject({
      isSecret: true,
      value: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(payloadFor("wordpress-db")).toMatchObject({
      exposed: false,
      publicEndpoints: [],
      ports: [],
    });
    const service = createServiceMock.mock.calls.find((call) => call[2]?.name === "wordpress")![2];
    expect(service).toMatchObject({
      image: "wordpress:7.1.3-php8.3-apache",
      commandArgv: ["sh", "/etc/openship/wordpress-start.sh", "apache2-foreground"],
      advanced: { files: [expect.objectContaining({ path: "/etc/openship/wordpress-start.sh" })] },
    });
    expect(service.advanced.build).toBeUndefined();
    expect(JSON.stringify(service.advanced.files)).not.toContain(dbPassword.value);
    expect(JSON.stringify(service.advanced.files)).not.toContain(
      wordpress.find((field) => field.key === "OPENSHIP_ADMIN_PASSWORD")!.value,
    );
  },
);

it.each(
  ["paperless-ngx", "wiki-js", "homepage", "immich", "jellyfin"].flatMap((templateId) =>
    ["self-hosted", "cloud"].map((mode) => ({ templateId, mode })),
  ),
)(
  "installs $templateId with private dependencies and encrypted setup ($mode)",
  async ({ templateId, mode }) => {
    const template = getAppTemplate(templateId)!;
    const services = template.services!;
    listServicesMock.mockResolvedValue(
      services.map((service) => ({ id: "svc-" + service.name, name: service.name })),
    );
    const endpoint = template.endpoints!.find((endpoint) => endpoint.kind === "http")!;
    await installApp(ctx, {
      templateId,
      ...(mode === "cloud" ? { serverId: "cloud-server", deployTarget: "cloud" as const } : {}),
      routes: [
        {
          service: endpoint.service,
          port: endpoint.port,
          mode: "custom",
          customDomain: "app.example.com",
        },
      ],
    });
    const envWrites = new Map(
      setEnvMock.mock.calls.map((call) => [
        call[2],
        call[3].vars as Array<{ key: string; value: string; isSecret: boolean }>,
      ]),
    );
    const secretGroups = new Map<string, string>();
    for (const spec of services) {
      const service = createServiceMock.mock.calls.find((call) => call[2]?.name === spec.name)![2];
      expect(service.image).toBe(spec.image);
      expect(service.advanced.build).toBeUndefined();
      expect(service.advanced.resources).toBeUndefined();
      expect(service.commandArgv).toEqual(spec.commandArgv);
      if (spec.entrypointArgv) expect(service.advanced.entrypoint).toEqual(spec.entrypointArgv);
      if (spec.name !== endpoint.service)
        expect(service).toMatchObject({ exposed: false, ports: [], publicEndpoints: [] });
      const variables = envWrites.get("svc-" + spec.name) ?? [];
      for (const field of template.configFields ?? []) {
        if (field.service !== spec.name || !field.secret) continue;
        const value = variables.find((value) => value.key === field.key)!;
        expect(value.isSecret).toBe(true);
        expect(value.value).toMatch(/^[a-f0-9]{64}$/);
        expect(JSON.stringify(service.environment)).not.toContain(value.value);
        expect(JSON.stringify(service.advanced.files ?? [])).not.toContain(value.value);
        if (field.generateGroup) {
          if (secretGroups.has(field.generateGroup))
            expect(value.value).toBe(secretGroups.get(field.generateGroup));
          else secretGroups.set(field.generateGroup, value.value);
        }
      }
    }
  },
);

it("installs Odoo's startup helper as runtime configuration without an image build", async () => {
  listServicesMock.mockResolvedValue([
    { id: "svc-odoo", name: "odoo" },
    { id: "svc-odoo-db", name: "odoo-db" },
  ]);
  await installApp(ctx, {
    templateId: "odoo",
    config: { OPENSHIP_ADMIN_EMAIL: "owner@example.com" },
  });
  const service = createServiceMock.mock.calls.find((call) => call[2]?.name === "odoo")![2];
  expect(service).toMatchObject({
    image: "odoo:19.0-20260926",
    commandArgv: ["python3", "/etc/openship/odoo-start.py"],
    advanced: { files: [expect.objectContaining({ path: "/etc/openship/odoo-start.py" })] },
  });
  expect(service.advanced.build).toBeUndefined();
  expect(payloadFor("odoo-db")).toMatchObject({ exposed: false, ports: [], publicEndpoints: [] });
});

describe("app install — routing comes from the operator's choice", () => {
  it("persists Cloud Ghost without a domain as internal, and publishes only a chosen domain", async () => {
    const input = { templateId: "ghost", serverId: "cloud-server" };
    await installApp(ctx, { ...input, routes: [{ service: "ghost", port: 2368, mode: "port" }] });
    expect(payloadFor("ghost")).toMatchObject({ exposed: false, publicEndpoints: [], ports: [] });
    createServiceMock.mockClear();
    await installApp(ctx, { ...input, routes: [{ service: "ghost", port: 2368, mode: "free" }] });
    expect(payloadFor("ghost")).toMatchObject({
      exposed: true,
      ports: [],
      publicEndpoints: [{ port: 2368, domainType: "free" }],
    });
    expect(payloadFor("ghost-db")).toMatchObject({ exposed: false, ports: [], publicEndpoints: [] });
  });
  it("keeps catalog resource recommendations advisory on self-hosted installs", async () => {
    await installApp(ctx, { templateId: "supabase" });
    expect(createServiceMock.mock.calls).toHaveLength(9);
    expect(
      createServiceMock.mock.calls.every((call) => call[2].advanced?.resources === undefined),
    ).toBe(true);
  });
  it("persists a custom domain and NO free route for the chosen endpoint", async () => {
    await install([
      { service: "backend", port: 3210, mode: "custom", customDomain: "API.Example.com" },
      { service: "dashboard", port: 6791, mode: "port" },
    ]);

    const backend = payloadFor("backend")!;
    expect(backend.exposed).toBe(true);
    expect(backend.domainType).toBe("custom");
    expect(backend.publicEndpoints).toEqual([
      { port: 3210, domainType: "custom", customDomain: "api.example.com" },
    ]);

    // Port-only persists no hostname, but it does persist a deliberately public
    // fixed binding; otherwise the URL shown by the wizard is fiction.
    const dashboard = payloadFor("dashboard")!;
    expect(dashboard.exposed).toBe(false);
    expect(dashboard.publicEndpoints).toEqual([]);
    expect(dashboard.ports).toContain("0.0.0.0:6791:6791");
  });

  it("invents nothing when the caller sends no routing", async () => {
    await install();
    for (const name of ["backend", "dashboard"]) {
      const payload = payloadFor(name)!;
      expect(payload.exposed).toBe(false);
      expect(payload.publicEndpoints).toEqual([]);
      expect(payload.domainType).toBeUndefined();
    }
    expect(requireCloudMock).not.toHaveBeenCalled();
  });

  it("uses the template's default label only when free was explicitly chosen", async () => {
    await install([{ service: "backend", port: 3210, mode: "free" }]);
    // ONLY the chosen port. The declared secondary (Convex's HTTP-actions 3211)
    // gets its own wizard picker via `declaredServiceRoutes`, so it is never minted
    // behind the operator; left unchosen it has no hostname at all, and
    // `{{publicUrl:backend:3211}}` resolves to the published host:port instead.
    expect(payloadFor("backend")!.publicEndpoints).toEqual([
      { port: 3210, domainType: "free", domain: "convex-backend" },
    ]);
    expect(payloadFor("dashboard")!.exposed).toBe(false);
  });

  it("honors a typed slug, and labels a separately chosen secondary from the template", async () => {
    await install([
      { service: "backend", port: 3210, mode: "free", domain: "MyConvex" },
      { service: "backend", port: 3211, mode: "free" },
    ]);
    // Declared order decides which route is primary (entry[0] mirrors the scalar
    // columns), regardless of the order the choices arrive in.
    expect(payloadFor("backend")!.publicEndpoints).toEqual([
      { port: 3210, domainType: "free", domain: "myconvex" },
      { port: 3211, domainType: "free", domain: "convex-backend-http" },
    ]);
  });

  it("gates a chosen free route on Openship Cloud BEFORE anything is written", async () => {
    requireCloudMock.mockRejectedValue(new Error("cloud-required"));
    await expect(install([{ service: "backend", port: 3210, mode: "free" }])).rejects.toThrow(
      /cloud-required/,
    );
    expect(createProjectMock).not.toHaveBeenCalled();
    expect(createServiceMock).not.toHaveBeenCalled();
    expect(requireCloudMock).toHaveBeenCalledWith("managed-project-domain", {
      organizationId: "org1",
    });
  });

  it("refuses a custom choice with no hostname, writing nothing", async () => {
    await expect(
      install([{ service: "backend", port: 3210, mode: "custom", customDomain: "  " }]),
    ).rejects.toThrow(/Enter the domain/i);
    expect(createProjectMock).not.toHaveBeenCalled();
  });

  it("refuses routing for a service or port the app doesn't serve", async () => {
    await expect(install([{ service: "nope", port: 3210, mode: "port" }])).rejects.toThrow(
      /no service named/i,
    );
    await expect(install([{ service: "backend", port: 9999, mode: "free" }])).rejects.toThrow(
      /doesn't serve port 9999/i,
    );
    expect(createProjectMock).not.toHaveBeenCalled();
  });

  it("atomically reconciles routing and ports on an adopted failed draft", async () => {
    draftMock.mockResolvedValue({ id: "p1", slug: "convex", name: "Convex" });
    listServicesMock.mockResolvedValue([
      {
        id: "svc-backend",
        name: "backend",
        // A prior attempt chose port-only for both endpoints.
        ports: ["0.0.0.0:3210:3210", "0.0.0.0:3211:3211"],
      },
      {
        id: "svc-dashboard",
        name: "dashboard",
        ports: ["0.0.0.0:6791:6791"],
      },
    ]);

    await install([
      { service: "backend", port: 3210, mode: "custom", customDomain: "api.example.com" },
      { service: "backend", port: 3211, mode: "port" },
      { service: "dashboard", port: 6791, mode: "port" },
    ]);

    expect(createProjectMock).not.toHaveBeenCalled();
    expect(createServiceMock).not.toHaveBeenCalled();
    const backendPatch = updateServiceMock.mock.calls.find(
      (call) => call[2] === "svc-backend",
    )?.[3];
    expect(backendPatch).toMatchObject({
      exposed: true,
      ports: ["3210:3210", "0.0.0.0:3211:3211"],
      publicEndpoints: [{ port: 3210, domainType: "custom", customDomain: "api.example.com" }],
    });
  });
});

describe("installServicePorts", () => {
  it("keeps Cloud No-domain endpoints private and removes stale host-port promises", () => {
    const ghost = getAppTemplate("ghost")!.services!.find((svc) => svc.name === "ghost")!;
    const routes = [{ service: "ghost", port: 2368, mode: "port" as const }];
    expect(installServicePorts("ghost", ghost.ports, routes, ghost.ports, "cloud")).toEqual([]);
    expect(
      installServicePorts("ghost", ghost.ports, routes, ["0.0.0.0:8212:2368", "9000:9000"], "cloud"),
    ).toEqual(["9000:9000"]);
    expect(installServicePorts("ghost", ghost.ports, routes)).toEqual(["0.0.0.0:8212:2368"]);
  });

  it("publishes Supabase Kong and gives its publicUrl token a real URL", () => {
    const kong = getAppTemplate("supabase")!.services!.find((svc) => svc.name === "kong")!;
    const ports = installServicePorts(kong.name, kong.ports, [
      { service: "kong", port: 8000, mode: "port" },
    ]);
    expect(ports).toEqual(["0.0.0.0:8000:8000"]);

    // This is the same lookup the deploy uses for `{{publicUrl:kong}}` in
    // Supabase Auth/Studio env. The missing pair was the issue's runtime failure.
    const urls = buildPublicUrlLookup(
      [{ name: "kong", portPairs: servicePortPairs(ports), primaryPort: 8000 }],
      "203.0.113.5",
    );
    expect(urls.get("kong")).toBe("http://203.0.113.5:8000");
  });

  it("makes an authored host remap public while preserving its protocol", () => {
    expect(
      installServicePorts("web", ["8203:80/tcp"], [{ service: "web", port: 80, mode: "port" }]),
    ).toEqual(["0.0.0.0:8203:80/tcp"]);
  });

  it("preserves an explicit template interface instead of widening it", () => {
    expect(
      installServicePorts(
        "admin",
        ["127.0.0.1:9000:9000"],
        [{ service: "admin", port: 9000, mode: "port" }],
      ),
    ).toEqual(["127.0.0.1:9000:9000"]);
  });

  it("is idempotent on a failed-draft retry", () => {
    const routes: InstallAppRoute[] = [{ service: "kong", port: 8000, mode: "port" }];
    const once = installServicePorts("kong", [], routes);
    expect(installServicePorts("kong", [], routes, once)).toEqual(once);
  });

  it("removes its generated binding when a retry switches port-only to a domain", () => {
    expect(
      installServicePorts(
        "kong",
        [],
        [{ service: "kong", port: 8000, mode: "custom", customDomain: "db.example.com" }],
        ["0.0.0.0:8000:8000", "127.0.0.1:9000:9000"],
      ),
    ).toEqual(["127.0.0.1:9000:9000"]);
  });

  it("restores an authored remap when a retry switches to a domain", () => {
    expect(
      installServicePorts(
        "web",
        ["8203:80/tcp"],
        [{ service: "web", port: 80, mode: "free" }],
        ["0.0.0.0:8203:80/tcp", "127.0.0.1:9000:9000"],
      ),
    ).toEqual(["8203:80/tcp", "127.0.0.1:9000:9000"]);
  });

  it("does not remove an unrelated operator remap while reconciling a domain", () => {
    expect(
      installServicePorts(
        "kong",
        [],
        [{ service: "kong", port: 8000, mode: "free" }],
        ["0.0.0.0:18000:8000"],
      ),
    ).toEqual(["0.0.0.0:18000:8000"]);
  });
});

describe("planInstallRouting", () => {
  const template = {
    services: [
      {
        name: "minio",
        image: "minio",
        exposedPort: 9001,
        exposed: true,
        routes: [{ port: 9001 }, { port: 9000, slugSuffix: "s3" }],
      },
      { name: "db", image: "pg", exposed: false, ports: ["5432:5432"] },
    ],
  };

  it("keeps each chosen port's own hostname, in declared order", () => {
    const plan = planInstallRouting(template, "store", [
      { service: "minio", port: 9000, mode: "custom", customDomain: "s3.example.com" },
      { service: "minio", port: 9001, mode: "free", domain: "console" },
    ]);
    expect(plan.get("minio")).toEqual({
      exposed: true,
      publicEndpoints: [
        { port: 9001, domainType: "free", domain: "console" },
        { port: 9000, domainType: "custom", customDomain: "s3.example.com" },
      ],
    });
  });

  it("gives a secondary route no hostname when the primary is custom", () => {
    const plan = planInstallRouting(template, "store", [
      { service: "minio", port: 9001, mode: "custom", customDomain: "console.example.com" },
    ]);
    expect(plan.get("minio")!.publicEndpoints).toEqual([
      { port: 9001, domainType: "custom", customDomain: "console.example.com" },
    ]);
  });

  it("leaves an unmentioned service unexposed", () => {
    const plan = planInstallRouting(template, "store", []);
    expect(plan.get("db")).toEqual({ exposed: false, publicEndpoints: [] });
    expect(plan.get("minio")).toEqual({ exposed: false, publicEndpoints: [] });
  });
});

/**
 * The patch has to survive the MERGE, not just look right on its own: it is
 * applied to a row that already exists (a re-install, or the webmail proxy
 * variant's `reapplyRouting`), so what matters is the routing the row ends up
 * with. Asserted through `mergeServiceRoutingPatch` for that reason.
 */
describe("serviceRoutingPatch", () => {
  const routed = {
    exposed: true,
    exposedPort: "3210",
    ports: ["3210:3210"],
    domain: null,
    customDomain: "webmail.example.com",
    domainType: "custom",
    publicEndpoints: [{ port: 3210, domainType: "custom", customDomain: "webmail.example.com" }],
  } as StoredServiceRouting;

  it("unroutes the row when the plan is empty", () => {
    // An empty plan is a DECISION (route by port only / the webmail proxy
    // variant), not an absence. Omitting the scalars made it unsayable: the
    // array cleared while the row kept the hostname it was redeployed to drop,
    // which kept its derived domain row alive — and a surviving row is what made
    // `onWebmailDeployed` skip registering the vhost + cert for the hostname the
    // operator actually asked for.
    const next = mergeServiceRoutingPatch({
      patch: serviceRoutingPatch({ exposed: false, publicEndpoints: [] }),
      stored: routed,
    });

    expect(next.exposed).toBe(false);
    expect(next.domain).toBeNull();
    expect(next.customDomain).toBeNull();
    expect(next.publicEndpoints).toEqual([]);
    // Same routing a FIRST install writes for an empty plan (createService sends no
    // domainType, which normalizeRoutingFields resolves to "free" with null
    // hostnames) — which is the invariant reapplyRouting's docstring claims.
    expect(next.domainType).toBe("free");
  });

  it("replaces a stored hostname with the planned one", () => {
    const next = mergeServiceRoutingPatch({
      patch: serviceRoutingPatch({
        exposed: true,
        publicEndpoints: [{ port: 3210, domainType: "custom", customDomain: "mail.example.com" }],
      }),
      stored: routed,
    });

    expect(next.customDomain).toBe("mail.example.com");
    expect(next.domain).toBeNull();
  });
});

it("installs PostgreSQL with a fixed pgAdmin port and no hostname or Cloud requirement", async () => {
  await installApp(ctx, {
    templateId: "postgresql",
    name: "PostgreSQL",
    routes: [{ service: "pgadmin", port: 5050, mode: "port" }],
  });
  expect(payloadFor("pgadmin")).toMatchObject({
    exposed: false,
    publicEndpoints: [],
    ports: ["0.0.0.0:5050:5050"],
  });
  expect(payloadFor("postgres")).toMatchObject({ exposed: false, publicEndpoints: [], ports: [] });
  expect(requireCloudMock).not.toHaveBeenCalled();
});
