import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The app Connection card is BOTH a display surface and the "Use in a project"
 * injection source, so every value it ships gets persisted into a second
 * project's container env. It therefore has exactly two truths to read from: the
 * backing services' stored env, and the project's PERSISTED domain rows. A
 * hostname is never derived, and "unknown" is "" (the card's "—"), never a
 * plausible-looking guess.
 *
 * These cover the module end-to-end (getAppConnectionView) because that is where
 * the wiring lives: the `{{publicUrl:…}}`-in-a-stored-env-value substitution had
 * zero coverage, so deleting it left every test green while Convex's DEPLOYMENT
 * URL regressed to "—".
 */

const {
  findById,
  listEnvVars,
  listByProject,
  listDomains,
  getTemplateForOrg,
  resolveProjectServerHost,
} = vi.hoisted(() => ({
  findById: vi.fn(),
  listEnvVars: vi.fn(),
  listByProject: vi.fn(),
  listDomains: vi.fn(),
  getTemplateForOrg: vi.fn(),
  resolveProjectServerHost: vi.fn(),
}));

vi.mock("@repo/db", () => ({
  repos: {
    project: { findById, listEnvVars },
    service: { listByProject },
    domain: { listByProject: listDomains },
  },
}));

vi.mock("../../../src/modules/apps/catalog-source", () => ({ getTemplateForOrg }));

vi.mock("../../../src/lib/controller-helpers", () => ({
  assertResourceInOrg: () => undefined,
}));

// Rows are encrypt()-ed at rest; the prefix keeps "was decrypted" observable.
vi.mock("../../../src/lib/encryption", () => ({
  encrypt: (v: string) => `enc:${v}`,
  decrypt: (v: string) => (v.startsWith("enc:") ? v.slice(4) : v),
}));

// Only the server lookup is faked — isLoopbackHost stays REAL, since "is this
// host usable" is the behaviour under test.
vi.mock("../../../src/lib/server-target", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/lib/server-target")>()),
  resolveProjectServerHost,
}));

import { getAppConnectionView } from "../../../src/modules/apps/app-settings.service";
import type { RequestContext } from "../../../src/lib/request-context";

const ctx = { organizationId: "org1", userId: "u1" } as RequestContext;

/** Convex's real catalog shape: the DEPLOYMENT URL is an env value that still
 *  holds a `{{publicUrl:…}}` token at rest. */
const convexTemplate = {
  id: "convex",
  connection: {
    outputs: [
      { id: "url", label: "Deployment URL", source: "env:backend:CONVEX_CLOUD_ORIGIN" },
      { id: "site", label: "HTTP Actions URL", source: "env:backend:CONVEX_SITE_ORIGIN" },
      { id: "direct", label: "Direct", source: "publicUrl:backend:3210" },
      { id: "adminKey", label: "Admin Key", source: "env:backend:CONVEX_ADMIN_KEY", secret: true },
    ],
  },
};

const backend = {
  id: "svc-backend",
  name: "backend",
  ports: ["3210:3210", "3211:3211"],
  exposedPort: "3210",
  environment: {
    CONVEX_CLOUD_ORIGIN: "{{publicUrl:backend:3210}}",
    CONVEX_SITE_ORIGIN: "{{publicUrl:backend:3211}}",
  },
};

type DomainRow = {
  hostname: string;
  isPrimary: boolean;
  verified: boolean;
  serviceId: string | null;
  targetPort: number | null;
  targetPath: string | null;
  domainType: string | null;
  redirectTo: string | null;
  redirectStatus: number | null;
};

const domainRow = (over: Partial<DomainRow>): DomainRow => ({
  hostname: "api.example.com",
  isPrimary: true,
  verified: true,
  serviceId: null,
  targetPort: 3210,
  targetPath: null,
  domainType: "custom",
  redirectTo: null,
  redirectStatus: null,
  ...over,
});

const valueOf = (outputs: { id: string; value: string }[], id: string) =>
  outputs.find((o) => o.id === id)!.value;

beforeEach(() => {
  vi.clearAllMocks();
  findById.mockResolvedValue({
    id: "proj1",
    organizationId: "org1",
    slug: "convex-app",
    name: "convex-app",
    appTemplateId: "convex",
    activeDeploymentId: null,
  });
  getTemplateForOrg.mockResolvedValue(convexTemplate);
  listByProject.mockResolvedValue([backend]);
  listEnvVars.mockResolvedValue([{ key: "CONVEX_ADMIN_KEY", value: "enc:admin-secret" }]);
  listDomains.mockResolvedValue([]);
  resolveProjectServerHost.mockResolvedValue("203.0.113.5");
});

describe("stored `{{publicUrl:…}}` tokens in an env value", () => {
  it("resolves a routed port to its persisted hostname and a port-only sibling to its reachable host port", async () => {
    listDomains.mockResolvedValue([domainRow({ serviceId: "svc-backend", targetPort: 3210 })]);

    const { outputs } = await getAppConnectionView(ctx, "proj1");

    expect(valueOf(outputs, "url")).toBe("https://api.example.com");
    // A domain on ONE port must not swallow the others.
    expect(valueOf(outputs, "site")).toBe("http://203.0.113.5:3211");
    expect(valueOf(outputs, "direct")).toBe("https://api.example.com");
  });

  it("never ships a literal token: every value is a real value or empty", async () => {
    listDomains.mockResolvedValue([]);
    resolveProjectServerHost.mockResolvedValue(null);

    const { outputs } = await getAppConnectionView(ctx, "proj1");

    // The property, not one instance of it: nothing that survived resolution may
    // still contain a `{{…}}` of ANY grammar.
    for (const o of outputs) expect(o.value).not.toMatch(/\{\{[^{}]*\}\}/);
    expect(valueOf(outputs, "url")).toBe("");
    expect(valueOf(outputs, "site")).toBe("");
    expect(valueOf(outputs, "direct")).toBe("");
    // A value with no token is untouched by any of this.
    expect(valueOf(outputs, "adminKey")).toBe("admin-secret");
  });

  it("an env_vars override of a token value wins over the compose literal", async () => {
    listEnvVars.mockResolvedValue([
      { key: "CONVEX_CLOUD_ORIGIN", value: "enc:https://chosen.example.com" },
    ]);

    const { outputs } = await getAppConnectionView(ctx, "proj1");

    expect(valueOf(outputs, "url")).toBe("https://chosen.example.com");
  });
});

describe("persisted route rows are read verbatim", () => {
  it("keeps a free row whose hostname does not carry the instance's current routing base", async () => {
    // A managed row persisted under a routing base this instance no longer uses.
    // It is live on the edge; re-deriving `slug + <current base>` dropped it and
    // the card claimed the app had no URL at all.
    listDomains.mockResolvedValue([
      domainRow({
        serviceId: "svc-backend",
        hostname: "convex-app.legacy-base.test",
        domainType: "free",
        targetPort: 3210,
      }),
    ]);

    const { outputs } = await getAppConnectionView(ctx, "proj1");

    expect(valueOf(outputs, "url")).toBe("https://convex-app.legacy-base.test");
  });

  it("adopts a PROJECT-level row targeting a port this service publishes", async () => {
    listDomains.mockResolvedValue([domainRow({ serviceId: null, targetPort: 3211 })]);

    const { outputs } = await getAppConnectionView(ctx, "proj1");

    expect(valueOf(outputs, "site")).toBe("https://api.example.com");
    expect(valueOf(outputs, "url")).toBe("http://203.0.113.5:3210");
  });

  it("ignores a project-level row on a port no service publishes", async () => {
    listDomains.mockResolvedValue([domainRow({ serviceId: null, targetPort: 9999 })]);

    const { outputs } = await getAppConnectionView(ctx, "proj1");

    expect(valueOf(outputs, "url")).toBe("http://203.0.113.5:3210");
    expect(outputs.map((o) => o.value)).not.toContain("https://api.example.com");
  });

  it("skips a redirecting host — it sends the visitor elsewhere", async () => {
    listDomains.mockResolvedValue([
      domainRow({ serviceId: "svc-backend", targetPort: 3210, redirectTo: "www.example.com" }),
    ]);

    const { outputs } = await getAppConnectionView(ctx, "proj1");

    expect(valueOf(outputs, "url")).toBe("http://203.0.113.5:3210");
  });

  it("skips a path (static) target — there is no port URL to hand out", async () => {
    listDomains.mockResolvedValue([
      domainRow({ serviceId: "svc-backend", targetPort: null, targetPath: "/srv/site" }),
    ]);

    const { outputs } = await getAppConnectionView(ctx, "proj1");

    expect(valueOf(outputs, "url")).toBe("http://203.0.113.5:3210");
  });

  it("the primary row owns a contested port", async () => {
    listDomains.mockResolvedValue([
      domainRow({ serviceId: "svc-backend", hostname: "b.example.com", isPrimary: false }),
      domainRow({ serviceId: "svc-backend", hostname: "a.example.com", isPrimary: true }),
    ]);

    const { outputs } = await getAppConnectionView(ctx, "proj1");

    expect(valueOf(outputs, "url")).toBe("https://a.example.com");
  });
});

describe("port-only host is never invented", () => {
  it.each(["127.0.0.1", "127.0.1.1", "localhost", "0.0.0.0", "::1"])(
    "treats %s as unknown rather than an origin the app can be handed",
    async (host) => {
      resolveProjectServerHost.mockResolvedValue(host);

      const { outputs } = await getAppConnectionView(ctx, "proj1");

      // The property: no shipped value may carry a loopback origin.
      for (const o of outputs) expect(o.value).not.toContain(host);
      expect(valueOf(outputs, "url")).toBe("");
    },
  );

  it("does not substitute the openship instance's own hostname when no server is known", async () => {
    resolveProjectServerHost.mockResolvedValue(null);

    const { outputs } = await getAppConnectionView(ctx, "proj1");

    expect(valueOf(outputs, "url")).toBe("");
    expect(valueOf(outputs, "direct")).toBe("");
  });

  it("resolves a `{{host}}` template only against the project's real server", async () => {
    getTemplateForOrg.mockResolvedValue({
      id: "convex",
      connection: {
        outputs: [
          { id: "conn", label: "Conn", service: "backend", source: "template:http://{{host}}:3210" },
        ],
      },
    });

    const withHost = await getAppConnectionView(ctx, "proj1");
    expect(valueOf(withHost.outputs, "conn")).toBe("http://203.0.113.5:3210");

    resolveProjectServerHost.mockResolvedValue("127.0.0.1");
    const loopback = await getAppConnectionView(ctx, "proj1");
    expect(valueOf(loopback.outputs, "conn")).toBe("");
  });
});

describe("published-port pairs", () => {
  it("maps a container port to the HOST port it is actually published on", async () => {
    listByProject.mockResolvedValue([
      {
        ...backend,
        ports: ["18210:3210/tcp", "127.0.0.1:18211:3211"],
        environment: {
          CONVEX_CLOUD_ORIGIN: "{{publicUrl:backend:3210}}",
          CONVEX_SITE_ORIGIN: "{{publicUrl:backend:3211}}",
        },
      },
    ]);

    const { outputs } = await getAppConnectionView(ctx, "proj1");

    expect(valueOf(outputs, "url")).toBe("http://203.0.113.5:18210");
    expect(valueOf(outputs, "site")).toBe("http://203.0.113.5:18211");
  });

  it("ignores a container-only port spec — its host port is assigned at random", async () => {
    listByProject.mockResolvedValue([
      { ...backend, ports: ["3210"], exposedPort: "3210" },
    ]);

    const { outputs } = await getAppConnectionView(ctx, "proj1");

    expect(valueOf(outputs, "url")).toBe("");
  });

  it("an unset exposedPort is not port 0", async () => {
    listByProject.mockResolvedValue([
      { ...backend, ports: ["3210:3210"], exposedPort: null },
    ]);

    const { outputs } = await getAppConnectionView(ctx, "proj1");

    expect(valueOf(outputs, "url")).toBe("http://203.0.113.5:3210");
    expect(valueOf(outputs, "url")).not.toContain(":0");
  });
});

/**
 * A project with NO template `connection` block (plain single-app, raw compose,
 * monorepo, imported) is still internally reachable — it joins its own docker
 * network under a stable alias. `getAppConnectionView` synthesizes an
 * INTERNAL-address view so it can be a "Use in a project" source, not just a
 * consumer. Only `http://<alias>:<port>` is invented; no public/secret value is,
 * and the alias equals the container's primary docker alias (so it's the string
 * embedded DNS actually answers).
 */
describe("synthesized internal view (no template connection)", () => {
  const noTemplateProject = (over: Record<string, unknown> = {}) => ({
    id: "proj1",
    organizationId: "org1",
    slug: "my-app",
    name: "my-app",
    appTemplateId: null,
    activeDeploymentId: null,
    hasServer: true,
    productionMode: null,
    port: 8080,
    internalAlias: null,
    ...over,
  });

  beforeEach(() => {
    // No template ⇒ the synthesizer runs. Neutralize the convex fixture that the
    // outer beforeEach installs.
    findById.mockResolvedValue(noTemplateProject());
    getTemplateForOrg.mockResolvedValue(null);
    listByProject.mockResolvedValue([]);
  });

  it("service-based: one internal output per port-bound service, exposed first", async () => {
    listByProject.mockResolvedValue([
      { id: "s-db", name: "db", ports: ["5432:5432"], exposed: false, advanced: null },
      { id: "s-web", name: "web", ports: ["3000:3000"], exposed: true, advanced: null },
    ]);

    const view = await getAppConnectionView(ctx, "proj1");

    expect(view.guide?.defaultMode).toBe("internal");
    // Exposed service leads — a sibling usually wants the app, not its sidecar DB.
    expect(view.outputs.map((o) => o.value)).toEqual([
      "http://web:3000",
      "http://db:5432",
    ]);
    for (const o of view.outputs) expect(o.internal).toBe(true);
    expect(view.outputs.find((o) => o.id === "web")?.envKey).toBe("WEB_URL");
  });

  it("service-based: a custom `advanced.alias` becomes the hostname (DNS-normalized)", async () => {
    listByProject.mockResolvedValue([
      { id: "s-api", name: "api", ports: ["3000:3000"], exposed: true, advanced: { alias: "My Gateway" } },
    ]);

    const { outputs } = await getAppConnectionView(ctx, "proj1");

    // The value equals what embedded DNS answers — the alias validator and the
    // deploy path both normalize identically ("My Gateway" → "my-gateway").
    expect(outputs).toHaveLength(1);
    expect(outputs[0].value).toBe("http://my-gateway:3000");
    expect(outputs[0].service).toBe("my-gateway");
  });

  it("service-based: skips a service that binds no port", async () => {
    listByProject.mockResolvedValue([
      { id: "s-web", name: "web", ports: ["3000:3000"], exposed: true, advanced: null },
      { id: "s-worker", name: "worker", ports: [], exposed: false, advanced: null },
    ]);

    const { outputs } = await getAppConnectionView(ctx, "proj1");

    expect(outputs.map((o) => o.id)).toEqual(["web"]);
  });

  it("service-based: skips a STATIC monorepo sub-app even though it carries a port", async () => {
    // A static build (Vite) is served as files off the edge — no listening
    // container — yet persistMonorepoApps still writes it a port from the stack
    // default, so resolveServicePort returns non-null. Only isStaticService skips
    // it; without the guard it would be offered a dead `http://site:3000`.
    listByProject.mockResolvedValue([
      { id: "s-web", name: "web", ports: ["3000:3000"], exposed: true, advanced: null },
      {
        id: "s-site",
        name: "site",
        kind: "monorepo",
        framework: "vite",
        startCommand: null,
        ports: ["3000:3000"],
        exposed: true,
        advanced: null,
      },
    ]);

    const { outputs } = await getAppConnectionView(ctx, "proj1");

    expect(outputs.map((o) => o.id)).toEqual(["web"]);
  });

  it("service-based: static skip does not rely on a null port (exposedPort set, ports empty)", async () => {
    // The exact shape persistMonorepoApps writes: exposedPort from the stack, no
    // `ports`. resolveServicePort returns 3000 here, proving the `!port` guard
    // would NOT have caught this — isStaticService is what skips it.
    listByProject.mockResolvedValue([
      {
        id: "s-site",
        name: "site",
        kind: "monorepo",
        framework: "vite",
        startCommand: null,
        exposedPort: "3000",
        ports: [],
        exposed: true,
        advanced: null,
      },
    ]);

    const view = await getAppConnectionView(ctx, "proj1");

    expect(view).toEqual({ outputs: [] });
  });

  it("single-app (no services): one output at the project alias + port", async () => {
    const { outputs, guide } = await getAppConnectionView(ctx, "proj1");

    expect(guide?.defaultMode).toBe("internal");
    expect(outputs).toHaveLength(1);
    expect(outputs[0].value).toBe("http://my-app:8080");
    expect(outputs[0].internal).toBe(true);
  });

  it("single-app: falls back to port 3000 when the project row carries none", async () => {
    findById.mockResolvedValue(noTemplateProject({ port: null }));

    const { outputs } = await getAppConnectionView(ctx, "proj1");

    expect(outputs[0].value).toBe("http://my-app:3000");
  });

  it("single-app: a custom `internalAlias` wins over the slug", async () => {
    findById.mockResolvedValue(noTemplateProject({ internalAlias: "edge" }));

    const { outputs } = await getAppConnectionView(ctx, "proj1");

    expect(outputs[0].value).toBe("http://edge:8080");
    expect(outputs[0].service).toBe("edge");
  });

  it("static single-app has no listening container → no internal address", async () => {
    findById.mockResolvedValue(noTemplateProject({ productionMode: "static" }));

    const view = await getAppConnectionView(ctx, "proj1");

    expect(view).toEqual({ outputs: [] });
  });

  it("a serverless (hasServer:false) single-app is not offered either", async () => {
    findById.mockResolvedValue(noTemplateProject({ hasServer: false }));

    const view = await getAppConnectionView(ctx, "proj1");

    expect(view).toEqual({ outputs: [] });
  });
});
