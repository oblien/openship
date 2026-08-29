import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Stage B: a plain single-app / raw-compose source (NO template `connection`)
 * exposes a SYNTHESIZED output whose value is already the east-west address
 * (`http://<alias>:<port>`), tagged `internal: true`. `createConnection` must
 * inject that value VERBATIM in internal mode — never route it through
 * `toInternalUrl`, which needs a template and would return null (killing the
 * link). The co-location guard still fires first, so a cloud-hosted source — or one
 * on a genuinely different machine, since `openship-<slug>` networks are per-machine
 * — is steered to Public even when it carries a synthesized internal value. What
 * counts as "a different machine" is the delicate part, and most of the cases below
 * are about the pairs that are NOT: every encoding of this box is one machine, and a
 * project with no destination yet is not a second one.
 */

const h = vi.hoisted(() => ({
  findById: vi.fn(),
  listEnvVars: vi.fn(),
  deploymentFindById: vi.fn(),
  serverGetInOrganization: vi.fn(),
  isLocalHostRow: vi.fn(),
  listByTarget: vi.fn(),
  upsert: vi.fn(),
  getTemplateForOrg: vi.fn(),
  getAppConnectionView: vi.fn(),
  mergeEnvVars: vi.fn(),
  toInternalUrl: vi.fn(),
}));

vi.mock("@repo/db", () => ({
  repos: {
    project: { findById: h.findById, listEnvVars: h.listEnvVars },
    deployment: { findById: h.deploymentFindById },
    server: { getInOrganization: h.serverGetInOrganization },
    projectConnection: { listByTarget: h.listByTarget, upsert: h.upsert },
  },
}));

vi.mock("../../../src/lib/box-org", () => ({
  isLocalHostRow: h.isLocalHostRow,
}));

vi.mock("../../../src/modules/apps/catalog-source", () => ({
  getTemplateForOrg: h.getTemplateForOrg,
}));

vi.mock("../../../src/lib/controller-helpers", () => ({
  assertResourceInOrg: () => undefined,
}));

vi.mock("../../../src/lib/permission", () => ({
  permission: { assert: vi.fn(async () => undefined) },
}));

vi.mock("../../../src/modules/apps/app-settings.service", () => ({
  getAppConnectionView: h.getAppConnectionView,
}));

vi.mock("../../../src/modules/projects/project-env.service", () => ({
  mergeEnvVars: h.mergeEnvVars,
}));

// Only `toInternalUrl` is driven by this suite. Everything else — notably
// `isNetworkUrl`, which decides whether a value even HAS a host to rewrite — must
// be the shipped implementation: a hand-copy inside the factory would keep these
// tests green while the production predicate rotted.
vi.mock("../../../src/modules/projects/project-connection.util", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../src/modules/projects/project-connection.util")
  >()),
  toInternalUrl: h.toInternalUrl,
}));

import { createConnection } from "../../../src/modules/projects/project-connection.service";

const ctx = { organizationId: "org1", userId: "u1" } as never;

const SYNTH_OUTPUT = {
  id: "svc",
  label: "my-app",
  value: "http://my-app:8080",
  envKey: "MY_APP_URL",
  service: "my-app",
  internal: true,
  secret: false,
  width: "full" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  const projects = new Map<string, Record<string, unknown>>([
    ["app-a", { id: "app-a", name: "App A", slug: "app-a", organizationId: "org1", activeDeploymentId: null }],
    // Source: a plain app with no template and (by default) a self-hosted deploy.
    ["db-c", {
      id: "db-c", name: "Plain App", slug: "plain-app", organizationId: "org1",
      appTemplateId: null, activeDeploymentId: null,
    }],
  ]);
  h.findById.mockImplementation(async (id: string) => projects.get(id) ?? null);
  h.getTemplateForOrg.mockResolvedValue(null);
  h.getAppConnectionView.mockResolvedValue({ outputs: [SYNTH_OUTPUT], guide: { defaultMode: "internal" } });
  h.listEnvVars.mockResolvedValue([]);
  h.listByTarget.mockResolvedValue([]);
  h.deploymentFindById.mockResolvedValue(null);
  // Default: a server row that is NOT this box, so a serverId means a real remote.
  h.serverGetInOrganization.mockImplementation(async (id: string) => ({ id, isLocal: false }));
  h.isLocalHostRow.mockImplementation(async (row: { isLocal?: boolean }) => !!row?.isLocal);
  h.toInternalUrl.mockReturnValue(null);
  h.upsert.mockImplementation(async (row: Record<string, unknown>) => ({ ...row, id: "conn_new" }));
  h.mergeEnvVars.mockResolvedValue(undefined);
});

describe("createConnection — synthesized internal source", () => {
  it("injects the synthesized east-west value verbatim, bypassing toInternalUrl", async () => {
    const res = await createConnection(
      ctx,
      "app-a",
      { sourceProjectId: "db-c", outputId: "svc", envKey: "DB_URL", mode: "internal" },
      { defer: true },
    );

    expect(h.mergeEnvVars).toHaveBeenCalledWith(
      "app-a",
      "org1",
      expect.objectContaining({
        upserts: [{ key: "DB_URL", value: "http://my-app:8080", isSecret: true }],
      }),
    );
    // The template rewrite path must NOT run — it needs a template and would
    // null out a value that is already the container's DNS address.
    expect(h.toInternalUrl).not.toHaveBeenCalled();
    expect(res.connection.mode).toBe("internal");
    expect(res.requiresRedeploy).toBe(true);
  });

  it("still steers a CLOUD-hosted source to Public before injecting anything", async () => {
    // The DURABLE half of the union: a project bound to cloud that hasn't redeployed
    // has no snapshot to read. The snapshot half is pinned separately below —
    // neither signal alone catches every cloud shape.
    h.findById.mockImplementation(async (id: string) =>
      id === "app-a"
        ? { id: "app-a", name: "App A", slug: "app-a", organizationId: "org1", activeDeploymentId: null }
        : { id: "db-c", name: "Plain App", slug: "plain-app", organizationId: "org1", appTemplateId: null, activeDeploymentId: null, cloudWorkspaceId: "ws_1" },
    );

    await expect(
      createConnection(
        ctx,
        "app-a",
        { sourceProjectId: "db-c", outputId: "svc", envKey: "DB_URL", mode: "internal" },
        { defer: true },
      ),
    ).rejects.toThrow(/Public/);

    // Guard fires before the env write — no half-wired state.
    expect(h.mergeEnvVars).not.toHaveBeenCalled();
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("refuses internal when the two projects sit on DIFFERENT servers", async () => {
    // `openship-<slug>` networks are per-host, and attachLinkedNetworks only
    // WARNS when the attach fails — so a cross-server internal link injected an
    // alias that resolves nowhere and still deployed green.
    h.findById.mockImplementation(async (id: string) =>
      id === "app-a"
        ? { id: "app-a", name: "App A", slug: "app-a", organizationId: "org1", activeDeploymentId: null, serverId: "srv-a" }
        : { id: "db-c", name: "Plain App", slug: "plain-app", organizationId: "org1", appTemplateId: null, activeDeploymentId: null, serverId: "srv-b" },
    );

    await expect(
      createConnection(
        ctx,
        "app-a",
        { sourceProjectId: "db-c", outputId: "svc", envKey: "DB_URL", mode: "internal" },
        { defer: true },
      ),
    ).rejects.toThrow(/same server/i);

    expect(h.mergeEnvVars).not.toHaveBeenCalled();
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("treats the isLocal 'This Server' row and an unbound-but-deployed project as ONE machine", async () => {
    // The regression this pins: comparing raw serverId columns called these two
    // different machines. They are the same docker daemon — a project with no server
    // binding deploys to the host socket, and so does the isLocal row
    // (deployment-runtime `resolveTargetPlatform`) — so the same
    // `openship-<slug>` networks are reachable and internal MUST be allowed.
    h.serverGetInOrganization.mockImplementation(async (id: string) => ({ id, isLocal: true }));
    h.findById.mockImplementation(async (id: string) =>
      id === "app-a"
        ? { id: "app-a", name: "App A", slug: "app-a", organizationId: "org1", activeDeploymentId: "dep-a", serverId: null }
        : { id: "db-c", name: "Plain App", slug: "plain-app", organizationId: "org1", appTemplateId: null, activeDeploymentId: "dep-c", serverId: "srv-local" },
    );

    const res = await createConnection(
      ctx,
      "app-a",
      { sourceProjectId: "db-c", outputId: "svc", envKey: "DB_URL", mode: "internal" },
      { defer: true },
    );

    expect(res.connection.mode).toBe("internal");
    expect(h.mergeEnvVars).toHaveBeenCalledWith(
      "app-a",
      "org1",
      expect.objectContaining({
        upserts: [{ key: "DB_URL", value: "http://my-app:8080", isSecret: true }],
      }),
    );
  });

  it("allows connect-before-deploy when the source is on THIS box", async () => {
    // The app-install wizard wires declared connections BEFORE the first deploy. A
    // project bound to nothing is not unknown — resolveSnapshotTarget resolves that
    // exact shape to the host default — so its first deploy lands next to a source
    // that is already here, and refusing would reject a co-located pair.
    h.findById.mockImplementation(async (id: string) =>
      id === "app-a"
        ? { id: "app-a", name: "App A", slug: "app-a", organizationId: "org1", activeDeploymentId: null, serverId: null }
        : { id: "db-c", name: "Plain App", slug: "plain-app", organizationId: "org1", appTemplateId: null, activeDeploymentId: "dep-c", serverId: null },
    );

    const res = await createConnection(
      ctx,
      "app-a",
      { sourceProjectId: "db-c", outputId: "svc", envKey: "DB_URL", mode: "internal" },
      { defer: true },
    );

    expect(res.connection.mode).toBe("internal");
  });

  it("still refuses connect-before-deploy when the source is on a REMOTE server", async () => {
    // The other half, and the one that makes "no binding yet" a real answer rather
    // than an excuse to skip the check: an unbound target deploys HERE by default, so
    // a source on server A is a different machine and its alias would resolve nowhere.
    // Treating the unbound end as "nothing to refuse" injected that dead alias and
    // reported success.
    h.findById.mockImplementation(async (id: string) =>
      id === "app-a"
        ? { id: "app-a", name: "App A", slug: "app-a", organizationId: "org1", activeDeploymentId: null, serverId: null }
        : { id: "db-c", name: "Plain App", slug: "plain-app", organizationId: "org1", appTemplateId: null, activeDeploymentId: "dep-c", serverId: "srv-a" },
    );

    await expect(
      createConnection(
        ctx,
        "app-a",
        { sourceProjectId: "db-c", outputId: "svc", envKey: "DB_URL", mode: "internal" },
        { defer: true },
      ),
    ).rejects.toThrow(/same server/i);

    expect(h.mergeEnvVars).not.toHaveBeenCalled();
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("catches a cloud source from the deployment SNAPSHOT when cloudWorkspaceId is null", async () => {
    // A self-hosted instance orchestrating a cloud deploy deliberately leaves
    // `cloudWorkspaceId` null to stay local-canonical (deployment-lifecycle,
    // isLocalOrchestratedCloud), so the column alone reads "local" and the guard went
    // silent. `meta.deployTarget` is that shape's only cloud signal.
    h.findById.mockImplementation(async (id: string) =>
      id === "app-a"
        ? { id: "app-a", name: "App A", slug: "app-a", organizationId: "org1", activeDeploymentId: null, serverId: null }
        : { id: "db-c", name: "Plain App", slug: "plain-app", organizationId: "org1", appTemplateId: null, activeDeploymentId: "dep-c", serverId: null, cloudWorkspaceId: null },
    );
    h.deploymentFindById.mockResolvedValue({
      id: "dep-c",
      meta: { deployTarget: "cloud", buildStrategy: "local" },
    });

    await expect(
      createConnection(
        ctx,
        "app-a",
        { sourceProjectId: "db-c", outputId: "svc", envKey: "DB_URL", mode: "internal" },
        { defer: true },
      ),
    ).rejects.toThrow(/cloud-hosted/i);

    expect(h.mergeEnvVars).not.toHaveBeenCalled();
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("allows internal for two projects on the SAME server", async () => {
    h.findById.mockImplementation(async (id: string) =>
      id === "app-a"
        ? { id: "app-a", name: "App A", slug: "app-a", organizationId: "org1", activeDeploymentId: null, serverId: "srv-a" }
        : { id: "db-c", name: "Plain App", slug: "plain-app", organizationId: "org1", appTemplateId: null, activeDeploymentId: null, serverId: "srv-a" },
    );

    const res = await createConnection(
      ctx,
      "app-a",
      { sourceProjectId: "db-c", outputId: "svc", envKey: "DB_URL", mode: "internal" },
      { defer: true },
    );

    expect(res.connection.mode).toBe("internal");
  });

  it("a DEFAULTED mode falls back to public instead of failing the request", async () => {
    // Only an EXPLICIT `mode: "internal"` gets the error. When the caller never
    // chose, refusing would turn a working public wire-up into a dead end.
    h.findById.mockImplementation(async (id: string) =>
      id === "app-a"
        ? { id: "app-a", name: "App A", slug: "app-a", organizationId: "org1", activeDeploymentId: null, serverId: "srv-a" }
        : { id: "db-c", name: "Plain App", slug: "plain-app", organizationId: "org1", appTemplateId: null, activeDeploymentId: null, serverId: "srv-b" },
    );

    const res = await createConnection(
      ctx,
      "app-a",
      { sourceProjectId: "db-c", outputId: "svc", envKey: "DB_URL" },
      { defer: true },
    );

    expect(res.connection.mode).toBe("public");
    expect(h.mergeEnvVars).toHaveBeenCalledWith(
      "app-a",
      "org1",
      expect.objectContaining({
        upserts: [{ key: "DB_URL", value: "http://my-app:8080", isSecret: true }],
      }),
    );
  });

  it("a TEMPLATE (non-internal) output still routes through toInternalUrl", async () => {
    // Regression guard: the `if (!output.internal)` branch must not disturb the
    // existing template path — a template output IS rewritten to the alias URL.
    h.getAppConnectionView.mockResolvedValue({
      outputs: [{ ...SYNTH_OUTPUT, internal: false, value: "postgres://host:5432/db" }],
    });
    h.getTemplateForOrg.mockResolvedValue({ id: "postgres", connection: { outputs: [] } });
    h.toInternalUrl.mockReturnValue("postgres://my-app:5432/db");

    await createConnection(
      ctx,
      "app-a",
      { sourceProjectId: "db-c", outputId: "svc", envKey: "DB_URL", mode: "internal" },
      { defer: true },
    );

    // 4th arg = the container port the output's catalog source declares (null
    // here — this fixture's `connection.outputs` is empty).
    expect(h.toInternalUrl).toHaveBeenCalledWith("postgres://host:5432/db", expect.anything(), "my-app", null);
    expect(h.mergeEnvVars).toHaveBeenCalledWith(
      "app-a",
      "org1",
      expect.objectContaining({
        upserts: [{ key: "DB_URL", value: "postgres://my-app:5432/db", isSecret: true }],
      }),
    );
  });

  it("a TEMPLATE non-URL output (token, password, key) is injected verbatim in internal mode", async () => {
    h.getAppConnectionView.mockResolvedValue({
      outputs: [
        {
          id: "anonKey",
          label: "Anon Key",
          value: "eyJhbGciOiJIUzI1NiJ9.abc.def",
          envKey: "SUPABASE_ANON_KEY",
          service: "kong",
          internal: false,
          secret: false,
          width: "full" as const,
        },
      ],
    });
    h.getTemplateForOrg.mockResolvedValue({ id: "supabase", connection: { outputs: [] } });

    const res = await createConnection(
      ctx,
      "app-a",
      { sourceProjectId: "db-c", outputId: "anonKey", envKey: "SUPABASE_ANON_KEY", mode: "internal" },
      { defer: true },
    );

    expect(h.toInternalUrl).not.toHaveBeenCalled();
    expect(h.mergeEnvVars).toHaveBeenCalledWith(
      "app-a",
      "org1",
      expect.objectContaining({
        upserts: [{ key: "SUPABASE_ANON_KEY", value: "eyJhbGciOiJIUzI1NiJ9.abc.def", isSecret: true }],
      }),
    );
    expect(res.connection.mode).toBe("internal");
  });

  it("a non-URL output is NOT gated on co-location — a key works from any server", async () => {
    // The reachability guards must sit behind the verbatim path: a JWT carries no
    // host, so refusing it because the two projects sit on different servers would
    // re-break exactly what GH-631 reported.
    h.findById.mockImplementation(async (id: string) =>
      id === "app-a"
        ? { id: "app-a", name: "App A", slug: "app-a", organizationId: "org1", activeDeploymentId: null, serverId: "srv-a" }
        : { id: "db-c", name: "Supabase", slug: "supa", organizationId: "org1", appTemplateId: "supabase", activeDeploymentId: null, serverId: "srv-b" },
    );
    h.getAppConnectionView.mockResolvedValue({
      outputs: [
        {
          id: "anonKey",
          label: "Anon Key",
          value: "eyJhbGciOiJIUzI1NiJ9.abc.def",
          envKey: "SUPABASE_ANON_KEY",
          service: "kong",
          internal: false,
          secret: false,
          width: "full" as const,
        },
      ],
    });
    h.getTemplateForOrg.mockResolvedValue({ id: "supabase", connection: { outputs: [] } });

    const res = await createConnection(
      ctx,
      "app-a",
      { sourceProjectId: "db-c", outputId: "anonKey", envKey: "SUPABASE_ANON_KEY", mode: "internal" },
      { defer: true },
    );

    expect(res.connection.mode).toBe("internal");
    expect(h.mergeEnvVars).toHaveBeenCalledWith(
      "app-a",
      "org1",
      expect.objectContaining({
        upserts: [{ key: "SUPABASE_ANON_KEY", value: "eyJhbGciOiJIUzI1NiJ9.abc.def", isSecret: true }],
      }),
    );
  });
});
