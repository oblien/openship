import { BuildLogger, DEFAULT_RESOURCE_CONFIG } from "@repo/adapters";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComposeAdvanced } from "@repo/core";

const state = vi.hoisted(() => ({
  services: [] as Array<Record<string, unknown>>,
  env: {} as Record<string, Record<string, string>>,
  effects: [] as string[],
  preparationReached: new Error("image preparation reached"),
}));
vi.mock("@repo/db", () => ({
  repos: {
    service: { listByProject: async () => state.services },
    project: {
      getEnvMap: async (_project: string, _environment: string, service: string | null) =>
        state.env[service ?? "project"] ?? {},
    },
  },
}));
vi.mock("@repo/platform/engine/lib/encryption", async () => {
  const { createEncryption } = await import("@repo/db/encryption");
  return createEncryption("compose-preflight-test-secret");
});
vi.mock("@repo/platform/engine/modules/deployments/compose/build.service", () => ({
  buildComposeImages: async () => {
    state.effects.push("image preparation");
    throw state.preparationReached;
  },
}));
vi.mock("@repo/platform/engine/modules/deployments/compose/deploy.service", () => ({
  deployComposeServices: async () => {
    state.effects.push("cutover");
  },
  composeDeployMadeNoChanges: () => false,
}));
vi.mock("@repo/platform/engine/modules/deployments/deployment-lifecycle", () => ({
  beginBuildTiming: vi.fn(),
  completeBuildTiming: vi.fn(),
  finishServiceDeploymentTimings: vi.fn(),
  cleanupBuildArtifact: vi.fn(),
  collectLogs: vi.fn(),
  onCancelled: vi.fn(),
  onFailure: vi.fn(),
  onNoChanges: vi.fn(),
  onReconciling: vi.fn(),
  onSuccess: vi.fn(),
  setDeploymentStatus: vi.fn(),
  routeIssuesWarning: vi.fn(),
}));

import { executeComposePipeline } from "@repo/platform/engine/modules/deployments/compose/pipeline";
import { encrypt } from "@repo/platform/engine/lib/encryption";
import { loadServiceDeployEnvironment } from "@repo/platform/engine/modules/deployments/compose/required-env-preflight";

function service(
  name: string,
  environment: Record<string, string>,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: name,
    name,
    projectId: "project",
    enabled: true,
    build: ".",
    environment,
    advanced: { environmentTemplateKeys: Object.keys(environment) } as ComposeAdvanced,
    ...overrides,
  };
}
function sealed(values: Record<string, string>) {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, encrypt(value)]));
}
function run(
  opts: {
    targets?: string[];
    refreshes?: string[];
    forceAll?: boolean;
    trigger?: string;
    frozen?: Record<string, string>;
    meta?: Record<string, unknown>;
  } = {},
) {
  return executeComposePipeline({
    project: { id: "project" } as never,
    dep: {
      id: "deployment",
      environment: "production",
      trigger: opts.trigger ?? "deploy",
      forceAll: opts.forceAll ?? false,
      envVars: sealed(opts.frozen ?? {}),
      meta: opts.meta,
    } as never,
    snapshot: { targetServiceIds: opts.targets, refreshServiceIds: opts.refreshes } as never,
    runtime: {} as never,
    routing: {} as never,
    ssl: {} as never,
    system: null,
    executor: null,
    usesManagedRouting: false,
    logger: new BuildLogger(() => {}),
    ctx: {} as never,
    buildSessionId: "build",
    composeInterpolationEnv: {},
    buildEnvVars: {},
    buildResources: DEFAULT_RESOURCE_CONFIG,
    runtimeResources: DEFAULT_RESOURCE_CONFIG,
  });
}

beforeEach(() => {
  state.services = [];
  state.env = {};
  state.effects = [];
});

describe("required Compose environment before image preparation", () => {
  it("retries the built image with the normal service-scoped secret loader", async () => {
    state.env.api = sealed({ SERVICE_TOKEN: "fixed-runtime-token" });
    const resolved = await loadServiceDeployEnvironment({
      projectId: "project",
      dep: { trigger: "retry", environment: "production", meta: { retryBuildFromDeploymentId: "old" } },
      service: service("api", {}) as never,
      projectEnv: { PROJECT_TOKEN: "current-project-value" },
      frozenEnv: { PROJECT_TOKEN: "saved-build-value" },
      logger: new BuildLogger(() => {}),
    });
    expect(resolved.env).toMatchObject({ PROJECT_TOKEN: "saved-build-value", SERVICE_TOKEN: "fixed-runtime-token" });
  });

  it("reports every missing key across source/image services before any build, pull or cutover", async () => {
    state.services = [
      service("api", { MAIL: "${MAIL:?private-custom-message}", BILLING: "${BILLING:?required}" }),
      service(
        "worker",
        { TOKEN: "${TOKEN:?required}", MAIL: "${MAIL:?required}" },
        { build: null, image: "worker:1" },
      ),
    ];
    state.env.project = sealed({ PRIVATE: "secret-value" });
    const failure = await run().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      'Required Compose environment variables are not configured. Service "api": BILLING, MAIL; Service "worker": MAIL, TOKEN',
    );
    expect((failure as Error).message).not.toMatch(/private-custom-message|secret-value/);
    expect(state.effects).toEqual([]);
  });

  it("uses project, deployment, inline and service-scoped values with Compose default semantics", async () => {
    state.services = [
      service("api", {
        PROJECT: "${PROJECT:?required}",
        FROZEN: "${FROZEN:?required}",
        INLINE: "literal",
        EMBEDDED: "prefix-${INLINE:?required}",
        SCOPED: "${SCOPED:?required}",
        PRESENT_EMPTY: "${PRESENT_EMPTY?required}",
        OPTIONAL: "${OPTIONAL:-fallback}",
      }),
    ];
    state.env.project = sealed({ PROJECT: "configured", SCOPED: "", PRESENT_EMPTY: "" });
    state.env.api = sealed({ SCOPED: "configured-for-api" });
    await expect(run({ frozen: { FROZEN: "captured" } })).rejects.toBe(state.preparationReached);
    expect(state.effects).toEqual(["image preparation"]);
  });

  it("excludes disabled and untargeted services while validating env-only refresh targets", async () => {
    state.services = [
      service("api", { TOKEN: "${TOKEN:?required}" }),
      service("untouched", { MISSING: "${MISSING:?required}" }),
      service("disabled", { MISSING: "${MISSING:?required}" }, { enabled: false }),
    ];
    state.env.api = sealed({ TOKEN: "configured" });
    await expect(run({ targets: ["api"], refreshes: ["api"] })).rejects.toBe(
      state.preparationReached,
    );
    expect(state.effects).toEqual(["image preparation"]);
    state.effects = [];
    state.env.api = {};
    await expect(run({ targets: ["api"], refreshes: ["api"] })).rejects.toThrow(
      'Service "api": TOKEN',
    );
    expect(state.effects).toEqual([]);
    state.env.api = sealed({ TOKEN: "configured" });
    await expect(run({ targets: ["api"], forceAll: true })).rejects.toThrow(
      'Service "untouched": MISSING',
    );
    expect(state.effects).toEqual([]);
  });

  it("does not let a sibling's scoped secret satisfy another service's requirement", async () => {
    state.services = [service("api", { TOKEN: "${TOKEN:?required}" }), service("worker", {})];
    state.env.worker = sealed({ TOKEN: "worker-only" });
    await expect(run()).rejects.toThrow('Service "api": TOKEN');
    expect(state.effects).toEqual([]);
  });

  it("honors frozen rollback overrides and leaves services added after that release alone", async () => {
    state.services = [
      service("api", { TOKEN: "${TOKEN:?required}" }),
      service("later", { MISSING: "${MISSING:?required}" }),
    ];
    state.env.api = sealed({ TOKEN: "" });
    await expect(
      run({
        trigger: "rollback",
        frozen: { TOKEN: "restored" },
        meta: { composeServices: [{ name: "api" }] },
      }),
    ).rejects.toBe(state.preparationReached);
    expect(state.effects).toEqual(["image preparation"]);
  });
});
