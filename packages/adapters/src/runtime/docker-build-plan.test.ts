import { describe, it, expect } from "vitest";
import { generateDockerfile } from "./docker-build-plan";
import type { BuildConfig } from "../types";

// generateDockerfile reads only a handful of fields; a partial cast keeps the
// fixtures readable (same pattern as deploy-pipeline.test.ts).
function config(over: Partial<BuildConfig>): BuildConfig {
  return {
    buildImage: "node:22",
    runtimeImage: "node:22",
    installCommand: "",
    buildCommand: "",
    startCommand: "node index.js",
    port: 3000,
    stack: "node",
    envVars: {},
    ...over,
  } as unknown as BuildConfig;
}

const PHP_START = 'SERVER_NAME=":$PORT" exec frankenphp run --config /etc/frankenphp/Caddyfile';

function phpConfig(over: Partial<BuildConfig> = {}): BuildConfig {
  return config({
    buildImage: "php:8.4-cli",
    runtimeImage: "dunglas/frankenphp:1-php8.4-bookworm",
    installCommand: "composer install --no-dev --optimize-autoloader",
    outputDirectory: "public",
    startCommand: PHP_START,
    port: 8000,
    stack: "laravel",
    packageManager: "composer",
    ...over,
  });
}

describe("generateDockerfile — PHP branch", () => {
  const df = generateDockerfile(phpConfig());

  it("builds on php-cli with Composer pulled in", () => {
    expect(df).toContain("FROM php:8.4-cli AS builder");
    expect(df).toContain("COPY --from=composer:2 /usr/bin/composer /usr/bin/composer");
    expect(df).toContain("composer install --no-dev --optimize-autoloader");
  });

  it("installs the same extension set in BOTH stages, not just pdo_mysql", () => {
    const installs = df.match(/RUN install-php-extensions [^\n]+/g) ?? [];
    expect(installs).toHaveLength(2);
    expect(installs[0]).toBe(installs[1]);
    for (const ext of ["pdo_pgsql", "pdo_mysql", "redis", "pcntl", "intl", "gd", "opcache"]) {
      expect(installs[0]).toContain(ext);
    }
  });

  it("caches the extension layer by installing it before the source copy", () => {
    const lines = df.split("\n");
    const extIdx = lines.findIndex((l) => l.startsWith("RUN install-php-extensions"));
    const copyIdx = lines.findIndex((l) => l === "COPY . /workspace");
    expect(extIdx).toBeGreaterThan(-1);
    expect(extIdx).toBeLessThan(copyIdx);
  });

  it("runs on FrankenPHP as a non-root user with Caddy's dirs made writable", () => {
    expect(df).toContain("FROM dunglas/frankenphp:1-php8.4-bookworm AS runtime");
    expect(df).toContain("COPY --from=builder --chown=www-data:www-data /workspace /app");
    expect(df).toContain("chown -R www-data:www-data /data/caddy /config/caddy");
    expect(df).toContain("USER www-data");
  });

  it("serves the project's output directory as the docroot", () => {
    expect(df).toContain("ENV SERVER_ROOT=public/");
    const renamed = generateDockerfile(
      phpConfig({ outputDirectory: "web", buildCommand: "npm i --force && npm run build" }),
    );
    expect(renamed).toContain("ENV SERVER_ROOT=web/");
    expect(renamed).toContain("COPY --from=assets --chown=www-data:www-data /workspace/web /app/web");
  });

  it("drops the fpm+nginx machinery entirely", () => {
    expect(df).not.toContain("nginx");
    expect(df).not.toContain("php-fpm");
    expect(df).not.toContain("envsubst");
    expect(df).not.toContain("fastcgi_pass");
    expect(df).not.toContain("docker-php-ext-install");
  });

  it("launches frankenphp via exec so SIGTERM reaches it, not a dev server", () => {
    expect(df).toContain(`CMD ["sh", "-c", ${JSON.stringify(PHP_START)}]`);
    expect(df).not.toContain("php artisan serve");
  });

  it("emits no asset stage when the project has no JS build", () => {
    expect(df).not.toContain("AS assets");
    expect(df).not.toContain("node:22-bookworm-slim");
  });
});

describe("generateDockerfile — PHP with a JS asset pipeline", () => {
  const df = generateDockerfile(phpConfig({ buildCommand: "npm i --force && npm run build" }));

  it("compiles assets in a Node stage (php:*-cli has no node) and copies the docroot forward", () => {
    expect(df).toContain("FROM node:22-bookworm-slim AS assets");
    expect(df).toContain("npm run build");
    expect(df).toContain(
      "COPY --from=assets --chown=www-data:www-data /workspace/public /app/public",
    );
  });

  it("keeps composer out of the asset stage and the asset build out of the composer stage", () => {
    const assetsStage = df.slice(df.indexOf("AS assets"), df.indexOf("AS runtime"));
    expect(assetsStage).not.toContain("composer");
    const builderStage = df.slice(df.indexOf("AS builder"), df.indexOf("AS assets"));
    expect(builderStage).not.toContain("npm run build");
  });

  it("preludes corepack for a non-npm package manager in the asset stage", () => {
    const pnpm = generateDockerfile(phpConfig({ buildCommand: "pnpm install && pnpm build" }));
    // The project PM is `composer`, so the prelude has to come from the command.
    expect(pnpm).toContain("corepack enable pnpm");
  });
});

describe("generateDockerfile — non-PHP is unaffected", () => {
  it("a same-image Node build stays single-stage with no nginx", () => {
    const df = generateDockerfile(config({ buildImage: "node:22", runtimeImage: "node:22" }));
    expect(df).toContain("FROM node:22");
    expect(df).not.toContain("nginx");
    expect(df).not.toContain("AS builder"); // single stage
  });

  it("still runs install and build in one RUN layer", () => {
    const df = generateDockerfile(
      config({
        buildImage: "node:22",
        runtimeImage: "node:22-slim",
        installCommand: "npm i --force",
        buildCommand: "npm run build",
      }),
    );
    const runLines = df.split("\n").filter((l) => l.startsWith("RUN "));
    expect(runLines).toHaveLength(1);
    expect(runLines[0]).toContain("npm i --force");
    expect(runLines[0]).toContain("npm run build");
  });
});

// A detected build/start command can name a dependency binary directly — the
// registry's nextjs default is literally `next build` / `next start`, and a
// package.json script says the same. `npm run` / `bun run` resolve those by
// prepending node_modules/.bin; a Dockerfile RUN and a container CMD do not, so
// the recipe has to. Without this the docker build strategy failed 100% of
// Next+Bun deploys with `next: not found`, exit 127 (openship#623).
describe("generateDockerfile — node_modules/.bin on PATH (#623)", () => {
  const bunNext = (over: Partial<BuildConfig> = {}) =>
    config({
      buildImage: "oven/bun:latest",
      runtimeImage: "oven/bun:latest",
      packageManager: "bun",
      installCommand: "bun install",
      buildCommand: "next build",
      startCommand: "next start",
      stack: "nextjs",
      ...over,
    });

  it("puts the project's bin dir on PATH for a single-stage bun build", () => {
    const df = generateDockerfile(bunNext());
    expect(df).toContain('ENV PATH="/workspace/node_modules/.bin:$PATH"');
  });

  it("declares PATH before the build RUN, so the bare binary resolves", () => {
    const df = generateDockerfile(bunNext());
    const lines = df.split("\n");
    const envIdx = lines.findIndex((l) => l.startsWith("ENV PATH="));
    const runIdx = lines.findIndex((l) => l.startsWith("RUN ") && l.includes("next build"));
    expect(envIdx).toBeGreaterThanOrEqual(0);
    expect(runIdx).toBeGreaterThanOrEqual(0);
    expect(envIdx).toBeLessThan(runIdx);
  });

  it("covers the CMD too — a bare `next start` would otherwise crash-loop at boot", () => {
    // Single stage: the build stage IS the runtime stage, so the one ENV serves both.
    const df = generateDockerfile(bunNext());
    expect(df).toContain('CMD ["sh", "-c", "next start"]');
    expect(df.indexOf("ENV PATH=")).toBeLessThan(df.indexOf("CMD "));
  });

  it("declares PATH ahead of COPY so the layer survives every source change", () => {
    const df = generateDockerfile(bunNext());
    const lines = df.split("\n");
    expect(lines.findIndex((l) => l.startsWith("ENV PATH="))).toBeLessThan(
      lines.findIndex((l) => l.startsWith("COPY . /workspace")),
    );
  });

  it("adds the hoisted workspace root as well for a monorepo sub-app, nearest first", () => {
    const df = generateDockerfile(bunNext({ rootDirectory: "apps/web", packageManager: "pnpm" }));
    expect(df).toContain(
      'ENV PATH="/workspace/apps/web/node_modules/.bin:/workspace/node_modules/.bin:$PATH"',
    );
  });

  it("covers the workspace-prepare RUN, which is its own layer an inline export could not reach", () => {
    const df = generateDockerfile(
      bunNext({
        rootDirectory: "apps/web",
        packageManager: "pnpm",
        workspacePrepareCommand: "pnpm install && pnpm prisma generate",
      }),
    );
    const lines = df.split("\n");
    expect(lines.findIndex((l) => l.startsWith("ENV PATH="))).toBeLessThan(
      lines.findIndex((l) => l.includes("prisma generate")),
    );
  });

  it("re-declares PATH in a multi-stage runtime, where the copy retargets to /app", () => {
    const df = generateDockerfile(bunNext({ buildImage: "node:22", runtimeImage: "node:22-slim" }));
    const envs = df.split("\n").filter((l) => l.startsWith("ENV PATH="));
    // ENV does not cross a FROM — the builder and the runtime each need their own.
    expect(envs).toEqual([
      'ENV PATH="/workspace/node_modules/.bin:$PATH"',
      'ENV PATH="/app/node_modules/.bin:$PATH"',
    ]);
    expect(df.indexOf('ENV PATH="/app/node_modules/.bin:$PATH"')).toBeLessThan(df.indexOf("CMD "));
  });

  it("puts the bin dir on PATH for a static build too (`vite build` is equally bare)", () => {
    const df = generateDockerfile(
      config({
        isStatic: true,
        packageManager: "npm",
        installCommand: "npm ci",
        buildCommand: "vite build",
        outputDirectory: "dist",
        stack: "vite",
      }),
    );
    expect(df).toContain('ENV PATH="/workspace/node_modules/.bin:$PATH"');
    // nginx serves files and runs no project binary, so its stage gains nothing.
    expect(df.split("\n").filter((l) => l.startsWith("ENV PATH="))).toHaveLength(1);
  });

  it("adds nothing for a non-node package manager — Go/Python have no node_modules", () => {
    for (const packageManager of ["pip", "go", "cargo", "composer"]) {
      const df = generateDockerfile(
        config({
          packageManager,
          buildImage: "python:3.12-slim",
          runtimeImage: "python:3.12-slim",
          installCommand: "pip install -r requirements.txt",
          startCommand: "uvicorn main:app",
        }),
      );
      expect(df, packageManager).not.toContain("node_modules/.bin");
      expect(df, packageManager).not.toContain("ENV PATH=");
    }
  });

  it("keeps install and build in one RUN layer — the PATH is an ENV, not a step", () => {
    const df = generateDockerfile(bunNext());
    const runLines = df.split("\n").filter((l) => l.startsWith("RUN "));
    expect(runLines).toHaveLength(1);
    expect(runLines[0]).toContain("bun install");
    expect(runLines[0]).toContain("next build");
    expect(runLines[0]).not.toContain("export PATH");
  });
});

// The way the fix above can silently undo itself. `buildEnvPrefix` emits its
// inline `export` INSIDE the RUN line, i.e. after the stage-level `ENV PATH`, so
// a project env var named PATH is the last writer and wins. And a PATH copied out
// of another platform's dashboard is an absolute literal, not `$PATH:extra` — so
// it deletes node_modules/.bin from the lookup path and every dependency binary is
// back at exit 127, this time with a green `docker build` right up to the failing
// step. The image already knows its own PATH; a build step has no business
// restating it, so PATH joins FORCE_COLOR/TERM in the exclusion set.
describe("generateDockerfile — a project env var named PATH cannot unset the bin dir (#623)", () => {
  // Same fixture as the sibling block above; kept local so neither can be
  // retuned for the other's cases.
  const nextApp = (over: Partial<BuildConfig> = {}) =>
    config({
      buildImage: "oven/bun:latest",
      runtimeImage: "oven/bun:latest",
      packageManager: "bun",
      installCommand: "bun install",
      buildCommand: "next build",
      startCommand: "next start",
      stack: "nextjs",
      ...over,
    });

  /**
   * The inline `export …` segments the recipe put on its RUN lines, split on the
   * same ` && ` the generator joins with. Asserting on these rather than on the
   * whole Dockerfile keeps the stage-level `ENV PATH` (which we WANT) out of the
   * way of the inline export (which we don't).
   */
  function inlineExports(df: string): string[] {
    return df
      .split("\n")
      .filter((line) => line.startsWith("RUN "))
      .flatMap((line) => line.slice("RUN ".length).split(" && "))
      .filter((step) => step.startsWith("export "));
  }

  function envPathLines(df: string): string[] {
    return df.split("\n").filter((line) => line.startsWith("ENV PATH="));
  }

  const HOSTILE_ENV: Record<string, string> = {
    FORCE_COLOR: "1",
    TERM: "xterm-256color",
    API_URL: "https://api.example.com",
    // Declared AFTER an ordinary var on purpose. Object.entries keeps insertion
    // order, so without the exclusion this lands mid-list as
    // `export API_URL='…' PATH='…' NO_COLOR='1'` — which a "the prefix does not
    // START with export PATH" check would sail straight past.
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/bin",
  };

  /** What every RUN line's export segment must be, for all four recipes: the
   *  ordinary var, the NO_COLOR default, and nothing else. One equality covers
   *  PATH/FORCE_COLOR/TERM being dropped AND the ordinary var surviving. */
  const EXPECTED_EXPORT = "export API_URL='https://api.example.com' NO_COLOR='1'";

  it("exports the project's other vars but never its PATH (JS recipe)", () => {
    const df = generateDockerfile(nextApp({ envVars: HOSTILE_ENV }));
    const exports = inlineExports(df);
    // Guard: an empty list would make the equality below pass for the wrong reason.
    expect(exports.length).toBeGreaterThan(0);
    for (const segment of exports) expect(segment).toBe(EXPECTED_EXPORT);
  });

  it("never lets the project's PATH value into the recipe at all", () => {
    const df = generateDockerfile(nextApp({ envVars: HOSTILE_ENV }));
    expect(df).not.toContain("/usr/local/sbin");
  });

  it("still emits the stage-level ENV PATH — identical to a project that set no PATH", () => {
    const hostile = generateDockerfile(nextApp({ envVars: HOSTILE_ENV }));
    const clean = generateDockerfile(nextApp({ envVars: {} }));
    expect(envPathLines(hostile)).toEqual(['ENV PATH="/workspace/node_modules/.bin:$PATH"']);
    // The exclusion is a filter on the inline prefix only; the ENV the fix added
    // must be byte-identical either way, on the runtime stage too.
    expect(envPathLines(hostile)).toEqual(envPathLines(clean));
    const multi = nextApp({ buildImage: "node:22", runtimeImage: "node:22-slim" });
    expect(envPathLines(generateDockerfile({ ...multi, envVars: HOSTILE_ENV }))).toEqual(
      envPathLines(generateDockerfile(multi)),
    );
  });

  it("covers the workspace-prepare layer, which carries its own copy of the prefix", () => {
    const df = generateDockerfile(
      nextApp({
        envVars: HOSTILE_ENV,
        rootDirectory: "apps/web",
        packageManager: "pnpm",
        workspacePrepareCommand: "pnpm install && pnpm prisma generate",
      }),
    );
    const prepare = df.split("\n").find((line) => line.includes("prisma generate"));
    expect(prepare).toBeDefined();
    expect(prepare).toContain("export API_URL=");
    expect(prepare).not.toContain("PATH=");
    expect(inlineExports(df).length).toBeGreaterThan(0);
    for (const segment of inlineExports(df)) expect(segment).toBe(EXPECTED_EXPORT);
  });

  it("covers the static recipe, which shares buildEnvPrefix", () => {
    const df = generateDockerfile(
      config({
        isStatic: true,
        packageManager: "npm",
        installCommand: "npm ci",
        buildCommand: "vite build",
        outputDirectory: "dist",
        stack: "vite",
        envVars: HOSTILE_ENV,
      }),
    );
    expect(df).toContain('ENV PATH="/workspace/node_modules/.bin:$PATH"');
    const exports = inlineExports(df);
    expect(exports.length).toBeGreaterThan(0);
    for (const segment of exports) expect(segment).toBe(EXPECTED_EXPORT);
  });

  it("covers the PHP asset stage — a Node stage inside a composer project", () => {
    const df = generateDockerfile(
      phpConfig({ buildCommand: "npm run build", envVars: HOSTILE_ENV }),
    );
    // The asset stage's own ENV survives; the composer stage has none to lose.
    expect(df).toContain('ENV PATH="/workspace/node_modules/.bin:$PATH"');
    const exports = inlineExports(df);
    // Both the composer install line and the asset build line carry a prefix.
    expect(exports.length).toBeGreaterThan(1);
    for (const segment of exports) expect(segment).toBe(EXPECTED_EXPORT);
    expect(df).not.toContain("/usr/local/sbin");
  });

  it("drops the exact key only — a var whose name merely contains PATH still ships", () => {
    // Also the reason the assertions above are equalities and not
    // `not.toContain("export PATH")`: `export PATH_PREFIX=…` matches that string.
    const df = generateDockerfile(
      nextApp({
        envVars: { PATH: "/usr/local/sbin", PATH_PREFIX: "/base", NEXT_PUBLIC_PATH: "/p" },
      }),
    );
    const exports = inlineExports(df);
    expect(exports.length).toBeGreaterThan(0);
    for (const segment of exports) {
      expect(segment).toBe("export PATH_PREFIX='/base' NEXT_PUBLIC_PATH='/p' NO_COLOR='1'");
    }
  });
});
