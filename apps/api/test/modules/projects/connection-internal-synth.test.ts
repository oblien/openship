import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Stage B: a plain single-app / raw-compose source (NO template `connection`)
 * exposes a SYNTHESIZED output whose value is already the east-west address
 * (`http://<alias>:<port>`), tagged `internal: true`. `createConnection` must
 * inject that value VERBATIM in internal mode — never route it through
 * `toInternalUrl`, which needs a template and would return null (killing the
 * link). The cloud-source guard still fires first, so a cloud-hosted source is
 * steered to Public even when it carries a synthesized internal value.
 */

const h = vi.hoisted(() => ({
  findById: vi.fn(),
  listEnvVars: vi.fn(),
  deploymentFindById: vi.fn(),
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
    projectConnection: { listByTarget: h.listByTarget, upsert: h.upsert },
  },
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

vi.mock("../../../src/modules/projects/project-connection.util", () => ({
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
    h.findById.mockImplementation(async (id: string) =>
      id === "app-a"
        ? { id: "app-a", name: "App A", slug: "app-a", organizationId: "org1", activeDeploymentId: null }
        : { id: "db-c", name: "Plain App", slug: "plain-app", organizationId: "org1", appTemplateId: null, activeDeploymentId: "dep1" },
    );
    h.deploymentFindById.mockResolvedValue({ id: "dep1", meta: { deployTarget: "cloud" } });

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

    expect(h.toInternalUrl).toHaveBeenCalledWith("postgres://host:5432/db", expect.anything(), "my-app");
    expect(h.mergeEnvVars).toHaveBeenCalledWith(
      "app-a",
      "org1",
      expect.objectContaining({
        upserts: [{ key: "DB_URL", value: "postgres://my-app:5432/db", isSecret: true }],
      }),
    );
  });
});
