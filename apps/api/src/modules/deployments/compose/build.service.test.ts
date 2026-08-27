import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { BuildLogger, DEFAULT_RESOURCE_CONFIG, type BuildConfig } from "@repo/adapters";
import { describe, expect, it, vi } from "vitest";

// buildComposeImages reads the project's services from the DB and broadcasts SSE
// status. Both are side effects the inline-build materialization contract does not
// depend on — stub them so the test exercises ONLY the materialize/COPY path.
// (Importing the real @repo/db would also risk the PGlite single-instance lock.)
const { listByProjectMock } = vi.hoisted(() => ({ listByProjectMock: vi.fn() }));
vi.mock("@repo/db", () => ({
  repos: { service: { listByProject: listByProjectMock } },
}));
vi.mock("../session-manager", () => ({
  broadcastServiceStatus: vi.fn(),
  broadcastInstallPhase: vi.fn(),
}));

import { buildComposeImages, resolveComposeBuildArgs } from "./build.service";

/**
 * These pin the AUTHOR-FACING contract of an inline catalog build (`advanced.build`):
 * the Dockerfile + `files[]` are materialized on the orchestrator under a per-service
 * subdir whose name is `sanitizeComposeImageName(service.name)`, inside ONE shared
 * context root, and `docker build` runs with that shared root as context. So a
 * template author writes `COPY <service-name>/<file>` — the subdir IS the public COPY
 * prefix. If the subdir scheme ever changes, every authored inline-build Dockerfile
 * breaks at `docker build` (COPY source not found) while the catalog string-match
 * tests stay green; this file is the regression guard against that silent break.
 *
 * The subdir rides in `dockerfilePath`, NOT `rootDirectory`, and that split is load
 * bearing: docker builds with the whole context dir, while cloud tars up
 * `rootDirectory` alone (cloud.ts resolveDockerfileBuildSource). Moving the subdir
 * into `rootDirectory` keeps docker working and silently breaks every COPY on cloud.
 */

const SNAPSHOT = {
  repoUrl: "",
  branch: "main",
  framework: "docker",
  buildImage: "",
  runtimeImage: "",
  packageManager: "",
  installCommand: "",
  buildCommand: "",
  outputDirectory: "",
  productionPaths: [] as string[],
  rootDirectory: "",
  port: 3000,
  startCommand: "",
  hasServer: true,
  hasBuild: false,
};

type InlineBuild = { dockerfile: string; files?: { path: string; content: string }[] };

// Only the fields buildComposeImages actually reads off a service row.
function inlineService(name: string, build: InlineBuild, id = name) {
  return {
    id,
    name,
    enabled: true,
    image: null,
    build: null,
    advanced: { build },
    framework: null,
    buildCommand: null,
    startCommand: null,
    rootDirectory: null,
    dockerfile: null,
  };
}

/** A compose row that builds from a directory in the linked repo. */
function repoService(
  overrides: Partial<{
    name: string;
    id: string;
    kind: string;
    build: string | null;
    dockerfile: string | null;
    buildArgs: Record<string, string | null> | null;
    rootDirectory: string | null;
    buildCommand: string | null;
    startCommand: string | null;
    framework: string | null;
    advanced: { buildArgTemplateKeys?: string[] } | null;
  }> = {},
) {
  // Spread, not `??` per field: an explicit `build: null` (a monorepo row) has to
  // survive, and `??` would restore the default.
  return {
    id: "svc-1",
    name: "dinohash",
    enabled: true,
    image: null,
    advanced: null,
    kind: "compose",
    build: "dinohash-service",
    dockerfile: "Dockerfile",
    rootDirectory: null,
    framework: null,
    buildCommand: null,
    startCommand: null,
    ...overrides,
  };
}

/** Materialized context roots currently sitting in os.tmpdir() (leak detector). */
function catalogTempRoots(): string[] {
  return readdirSync(tmpdir()).filter((n) => n.startsWith("openship-catalog-build-"));
}

type Captured = { config: BuildConfig; serviceName: string };

/**
 * Drive buildComposeImages with a FAKE runtime.buildImages that (a) captures each
 * service's resolved BuildConfig and (b) hands the materialized context root to
 * `onContext` while it still exists on disk — the `finally` rm's the temp root the
 * moment buildComposeImages returns, so any disk assertion must run inside here.
 */
async function run(
  services: unknown[],
  onContext?: (root: string, item: Captured) => void | Promise<void>,
  snapshotOverrides?: Partial<typeof SNAPSHOT>,
  buildEnvVars: Record<string, string> = {},
) {
  listByProjectMock.mockResolvedValue(services);
  const captured: Captured[] = [];
  const runtime = {
    name: "docker" as const,
    build: vi.fn(),
    buildImages: vi.fn(async (items: Array<Record<string, unknown>>) => {
      for (const item of items) {
        const entry: Captured = {
          config: item.config as BuildConfig,
          serviceName: item.serviceName as string,
        };
        captured.push(entry);
        const root = entry.config.localPath;
        if (root && onContext) await onContext(root, entry);
        (item.onResult as (r: unknown) => void)({
          sessionId: "s",
          status: "running",
          imageRef: `img/${entry.serviceName}`,
        });
      }
    }),
  };

  const result = await buildComposeImages({
    // Only the fields the function reads; the rest of the graph is stubbed.
    project: {
      id: "p1",
      slug: "app",
      name: "app",
      localPath: null,
      workspacePrepareCommand: null,
    } as never,
    dep: { id: "d1", branch: "main", commitSha: null, trigger: "deploy", meta: null } as never,
    runtime: runtime as never,
    logger: new BuildLogger(() => {}),
    snapshot: { ...SNAPSHOT, ...snapshotOverrides } as never,
    buildSessionId: "sess",
    buildEnvVars,
    buildResources: DEFAULT_RESOURCE_CONFIG,
  });
  return { result, captured };
}

describe("buildComposeImages — inline catalog build materialization", () => {
  it("materializes the Dockerfile + files under the sanitized service-name subdir and points the build config at the shared root", async () => {
    const dockerfile =
      'FROM alpine\nCOPY compute/hello.sh /hello.sh\nRUN chmod +x /hello.sh\nENTRYPOINT ["/hello.sh"]\n';
    let rootSeen = "";
    const disk: Record<string, string> = {};

    const { result, captured } = await run(
      [
        inlineService("compute", {
          dockerfile,
          files: [
            { path: "hello.sh", content: "echo hi\n" },
            { path: "conf/app.toml", content: "x=1\n" }, // nested path → dirname mkdir
          ],
        }),
      ],
      async (root) => {
        rootSeen = root;
        disk.dockerfile = await readFile(join(root, "compute", "Dockerfile"), "utf-8");
        disk.hello = await readFile(join(root, "compute", "hello.sh"), "utf-8");
        disk.nested = await readFile(join(root, "compute", "conf", "app.toml"), "utf-8");
      },
    );

    expect(captured).toHaveLength(1);
    const cfg = captured[0].config;
    // Source is the shared orchestrator temp root, not a repo clone.
    expect(cfg.localPath).toBe(rootSeen);
    expect(isAbsolute(cfg.localPath!)).toBe(true);
    expect(cfg.localPath).toContain("openship-catalog-build-");
    // The context stays the SHARED ROOT; the subdir — the author-facing COPY prefix
    // — rides in the Dockerfile path, so `COPY compute/…` resolves on every runtime.
    expect(cfg.rootDirectory).toBe("");
    expect(cfg.dockerfilePath).toBe("compute/Dockerfile");

    // Materialized exactly where `COPY compute/<file>` expects it.
    expect(disk.dockerfile).toBe(dockerfile);
    expect(disk.hello).toBe("echo hi\n");
    expect(disk.nested).toBe("x=1\n");

    expect(result.imageRefs.get("compute")).toBe("img/compute");

    // The temp root is removed once the build phase completes (no leak).
    expect(existsSync(rootSeen)).toBe(false);
  });

  it("sanitizes a service name with caps/spaces into the COPY-prefix subdir", async () => {
    let existedAtSubdir = false;
    const { captured } = await run(
      [
        inlineService(
          "My Compute",
          { dockerfile: "FROM alpine\n", files: [{ path: "x", content: "y" }] },
          "svc-1",
        ),
      ],
      (root) => {
        existedAtSubdir = existsSync(join(root, "my-compute", "x"));
      },
    );
    expect(captured[0].config.dockerfilePath).toBe("my-compute/Dockerfile");
    expect(existedAtSubdir).toBe(true);
  });

  it("rejects a service name that sanitizes to a parent ref, leaving no temp root behind", async () => {
    // sanitizeComposeImageName preserves dots, so ".." survives it — and the subdir is
    // joined onto the shared root, so an unguarded ".." writes the Dockerfile and every
    // context file into os.tmpdir(), one level ABOVE the dir cleanup() removes.
    const before = catalogTempRoots();
    await expect(
      run([
        inlineService("..", { dockerfile: "FROM alpine\n", files: [{ path: "x", content: "y" }] }),
      ]),
    ).rejects.toThrow(/invalid build-context subdir "\.\."/);
    expect(catalogTempRoots()).toEqual(before);
  });

  it("rejects two inline services whose names sanitize to the same subdir", async () => {
    await expect(
      run([
        inlineService("compute", { dockerfile: "FROM alpine\n" }, "a"),
        inlineService("Compute", { dockerfile: "FROM alpine\n" }, "b"),
      ]),
    ).rejects.toThrow(/both map to build-context subdir "compute"/);
  });

  it("rejects a context file path that escapes its service dir, leaving no temp root behind", async () => {
    // The throw lands AFTER mkdtemp, so this also pins the try/finally placement:
    // a materialize failure must not leak one temp dir per failed deploy.
    const before = catalogTempRoots();
    await expect(
      run([
        inlineService("compute", {
          dockerfile: "FROM alpine\n",
          files: [{ path: "../evil.sh", content: "x" }],
        }),
      ]),
    ).rejects.toThrow(/Invalid build file path "\.\.\/evil\.sh"/);
    expect(catalogTempRoots()).toEqual(before);
  });

  it("rejects an inline build blob with no Dockerfile contents", async () => {
    await expect(run([inlineService("compute", { dockerfile: "" })])).rejects.toThrow(
      /no Dockerfile contents/,
    );
  });

  it("rejects an inline build mixed with a repo-built service in the same batch", async () => {
    // Both would build from ONE shared tree (specs[0]'s), so the inline service
    // would fall through to the repo's root Dockerfile — reject instead.
    const repoService = {
      ...inlineService("api", { dockerfile: "" }, "b"),
      advanced: {},
      build: "./api",
    };
    await expect(
      run([inlineService("compute", { dockerfile: "FROM alpine\n" }, "a"), repoService]),
    ).rejects.toThrow(/can't be built alongside repo-built services \(api\)/);
  });

  it("allows a context filename that merely starts with dots (not a parent ref)", async () => {
    let existed = false;
    await run(
      [
        inlineService("compute", {
          dockerfile: "FROM alpine\n",
          files: [{ path: "..keep", content: "x" }],
        }),
      ],
      (root) => {
        existed = existsSync(join(root, "compute", "..keep"));
      },
    );
    expect(existed).toBe(true);
  });
});

/**
 * #634. `build` is a build CONTEXT — the DB column, the wire schema, the docs and the
 * dashboard label all say so — but the produced BuildConfig only carried it as
 * `rootDirectory`, which the docker runtime reads as "a subdir inside a whole-repo
 * context". So the service's own `COPY requirements.txt` resolved at the repo root.
 * These pin the producer side: which rows get a narrowed context, and which must not.
 */
describe("buildComposeImages — declared build context", () => {
  it("isolates build args for services sharing one context and Dockerfile (#689)", async () => {
    const shared = {
      build: "../../",
      dockerfile: "services/shared/Dockerfile",
    };
    const { captured } = await run(
      [
        repoService({
          id: "svc-api",
          name: "api",
          ...shared,
          buildArgs: {
            APP_PACKAGE: "@myorg/api",
            SHARED_VERSION: null,
            CHANNEL: "${RELEASE_CHANNEL:-stable}",
            VERSIONED: "pkg-${SHARED_VERSION}",
          },
          advanced: { buildArgTemplateKeys: ["CHANNEL", "VERSIONED"] },
        }),
        repoService({
          id: "svc-worker",
          name: "worker",
          ...shared,
          buildArgs: { APP_PACKAGE: "@myorg/worker", UNSET: null },
        }),
      ],
      undefined,
      { rootDirectory: "deploy/docker-compose" },
      { SHARED_VERSION: "1.2.3" },
    );

    expect(captured).toHaveLength(2);
    expect(captured.map(({ config }) => config.buildContextDirectory)).toEqual(["", ""]);
    expect(captured.map(({ config }) => config.dockerfilePath)).toEqual([
      "services/shared/Dockerfile",
      "services/shared/Dockerfile",
    ]);
    expect(captured[0].config.buildArgs).toEqual({
      APP_PACKAGE: "@myorg/api",
      SHARED_VERSION: "1.2.3",
      CHANNEL: "stable",
      VERSIONED: "pkg-1.2.3",
    });
    expect(captured[1].config.buildArgs).toEqual({ APP_PACKAGE: "@myorg/worker" });
  });

  it("reports missing required build-arg variables without values", () => {
    expect(() =>
      resolveComposeBuildArgs({ TOKEN: "${BUILD_TOKEN:?set BUILD_TOKEN}" }, {}, ["TOKEN"]),
    ).toThrow(/BUILD_TOKEN/);
  });

  it("resolves only raw-parser templates against the invocation environment", () => {
    expect(
      resolveComposeBuildArgs(
        {
          A: "one",
          B: "${A:-two}",
          C: "${HOST}",
          SELF: "${SELF:-fallback}",
          CLI_LITERAL: "$HOME",
          ESCAPED: "$$HOME",
        },
        { HOST: "host", SELF: "env-self", HOME: "/private/home" },
        ["B", "C", "SELF", "ESCAPED"],
      ),
    ).toEqual({
      A: "one",
      // Compose uses the invocation environment, not sibling build args.
      B: "two",
      C: "host",
      SELF: "env-self",
      // CLI-normalized/direct values are literal even when they contain `$`.
      CLI_LITERAL: "$HOME",
      // Raw Compose `$$` becomes one literal dollar exactly once.
      ESCAPED: "$HOME",
    });
  });

  it("hands the runtime the service's build directory as the docker context", async () => {
    const { captured } = await run([repoService()]);

    expect(captured).toHaveLength(1);
    const cfg = captured[0].config;
    expect(cfg.buildContextDirectory).toBe("dinohash-service");
    // BOTH, same value: cloud reads `rootDirectory` as its context root, docker reads
    // the explicit field. Dropping either regresses one target.
    expect(cfg.rootDirectory).toBe("dinohash-service");
    // Relative to the context, as compose defines it — not "dinohash-service/Dockerfile".
    expect(cfg.dockerfilePath).toBe("Dockerfile");
  });

  it("resolves the context against the compose file's directory", async () => {
    // Compose semantics: a file in `deploy/docker-compose/` saying `build: ../../api`
    // means the repo-root `api` directory.
    const { captured } = await run([repoService({ build: "../../api" })], undefined, {
      rootDirectory: "deploy/docker-compose",
    });

    expect(captured[0].config.buildContextDirectory).toBe("api");
    expect(captured[0].config.rootDirectory).toBe("api");
  });

  it("keeps the whole repo as the context for `build: .`", async () => {
    // Byte-identical to before the fix: every pre-existing root-compose project has
    // this shape, and "" means the source root on every runtime.
    const { captured } = await run([repoService({ build: "." })]);

    expect(captured[0].config.buildContextDirectory).toBe("");
    expect(captured[0].config.rootDirectory).toBe("");
  });

  it("never narrows the context for an inline catalog build", async () => {
    // Its context IS the materialized root; the per-service subdir rides in the
    // Dockerfile path so a template author's `COPY <service-name>/<file>` resolves.
    const { captured } = await run([
      inlineService("compute", { dockerfile: "FROM alpine\n" }, "svc-inline"),
    ]);

    expect(captured[0].config.buildContextDirectory).toBeUndefined();
    expect(captured[0].config.dockerfilePath).toBe("compute/Dockerfile");
  });

  it("never narrows the context for a monorepo sub-app", async () => {
    // A generated recipe COPYs the workspace root — a narrowed context cannot satisfy
    // it, and the runtime refuses the combination outright.
    const { captured } = await run([
      repoService({
        id: "svc-mono",
        name: "web",
        kind: "monorepo",
        build: null,
        dockerfile: null,
        rootDirectory: "apps/web",
        framework: "nextjs",
        buildCommand: "npm run build",
        startCommand: "npm start",
      }),
    ]);

    expect(captured[0].config.buildContextDirectory).toBeUndefined();
    expect(captured[0].config.rootDirectory).toBe("apps/web");
  });
});
