/**
 * Stack detector - detects framework, package manager, and build settings
 * from a repository's file listing and package.json / manifest files.
 *
 * All categories, output directories, and default commands are derived from
 * the STACKS registry in @repo/core - no duplication.
 *
 * Supports:
 *   JS/TS:   Next.js, Nuxt, SvelteKit, Astro, Vite, Angular, Gatsby, Remix,
 *            TanStack Start, CRA, Vue, Express, Fastify, Hono, NestJS, Koa,
 *            AdonisJS, Elysia
 *   Go:      Standard, Gin, Fiber, Echo
 *   Rust:    Standard, Actix, Axum, Rocket
 *   Python:  Standard, Django, Flask, FastAPI
 *   Ruby:    Rails, Sinatra
 *   PHP:     Laravel, Symfony
 *   Java:    Spring Boot, Quarkus
 *   C#:      .NET, Blazor
 *   Elixir:  Phoenix
 *   Generic: Node.js, static, Docker
 */

import {
  STACKS,
  STACK_IDS,
  OUTPUT_DIRECTORIES,
  getProjectType,
  getBuildImage,
  LANGUAGE_MANIFEST_FILES,
  collectDependencies,
  detectPort as detectPortFromLanguages,
  parseDeploymentMetadata,
  type StackId,
  type ProjectType,
  type StackDefinition,
  type StackDetection,
  type DeploymentMetadata,
} from "@repo/core";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RepoFile {
  name: string;
  type?: string;
}

export interface StackResult {
  stack: StackId;
  projectType: ProjectType;
  category: string;
  dependencies: Record<string, string>;
  packageManager: string;
  installCommand: string;
  buildCommand: string;
  startCommand: string;
  buildImage: string;
  outputDirectory: string;
  productionPaths: string[];
  port: number;
}

// ─── Manifest files to read for deep detection ───────────────────────────────

/**
 * Manifest filenames callers should fetch and pass to `detectStack`.
 *
 * Derived from `LANGUAGE_DETECTORS` - adding a language family in
 * `@repo/core/languages/` automatically adds its manifests here. The exported
 * shape is a tuple of lowercase basenames; preserve order from the registry
 * so callers can iterate deterministically.
 */
export const MANIFEST_FILES: readonly string[] = LANGUAGE_MANIFEST_FILES;

// ─── Package manager detection ───────────────────────────────────────────────

export function detectPackageManager(
  files: RepoFile[],
  packageJson?: { packageManager?: string; scripts?: Record<string, string>; engines?: Record<string, string> },
  fileContents?: Record<string, string>,
): string {
  const fileSet = new Set(files.map((f) => f.name.toLowerCase()));

  // ── Non-JS languages (check manifests first) ──
  if (fileSet.has("go.mod")) return "go";
  if (fileSet.has("cargo.toml")) return "cargo";
  if (fileSet.has("pyproject.toml")) {
    // Poetry and uv both live in pyproject.toml — disambiguate by content
    // (a `[tool.poetry]` table means Poetry). Default to uv otherwise.
    const py = fileContents?.["pyproject.toml"];
    if (py && /\[tool\.poetry\]/.test(py)) return "poetry";
    return "uv";
  }
  if (fileSet.has("pipfile")) return "pipenv";
  if (fileSet.has("requirements.txt")) return "pip";
  if (fileSet.has("gemfile")) return "bundler";
  if (fileSet.has("composer.json")) return "composer";
  if (fileSet.has("pom.xml")) return "maven";
  if (fileSet.has("build.gradle") || fileSet.has("build.gradle.kts")) return "gradle";
  if (fileSet.has("mix.exs")) return "mix";

  // ── .NET (detect via *.csproj or *.fsproj) ──
  for (const f of files) {
    const lower = f.name.toLowerCase();
    if (lower.endsWith(".csproj") || lower.endsWith(".fsproj") || lower.endsWith(".sln")) return "dotnet";
  }

  // ── JS/TS lock files (most reliable) ──
  if (fileSet.has("pnpm-lock.yaml")) return "pnpm";
  if (fileSet.has("bun.lockb") || fileSet.has("bun.lock")) return "bun";
  if (fileSet.has("package-lock.json")) return "npm";
  if (fileSet.has("yarn.lock")) return "yarn";

  // packageManager field in package.json
  if (packageJson?.packageManager) {
    const pm = packageJson.packageManager;
    if (pm.startsWith("pnpm")) return "pnpm";
    if (pm.startsWith("yarn")) return "yarn";
    if (pm.startsWith("bun")) return "bun";
    if (pm.startsWith("npm")) return "npm";
  }

  // Scripts hints
  if (packageJson?.scripts) {
    const vals = Object.values(packageJson.scripts).join(" ");
    if (vals.includes("pnpm")) return "pnpm";
    if (vals.includes("yarn")) return "yarn";
    if (vals.includes("bun")) return "bun";
  }

  // Engines
  if (packageJson?.engines) {
    if (packageJson.engines.pnpm) return "pnpm";
    if (packageJson.engines.yarn) return "yarn";
    if (packageJson.engines.bun) return "bun";
  }

  // Config files
  if (fileSet.has("pnpm-workspace.yaml") || fileSet.has(".pnpmfile.cjs")) return "pnpm";
  if (fileSet.has(".yarnrc") || fileSet.has(".yarnrc.yml")) return "yarn";
  if (fileSet.has("bunfig.toml")) return "bun";

  if (fileSet.has("package.json")) return "npm";

  return "unknown";
}

/**
 * The JS package manager of a repo whose PRIMARY package manager is something
 * else. A Laravel app is detected as `composer` — correct for its dependencies,
 * but useless for its asset build, which still needs to know whether to run
 * `npm ci` or `pnpm install`. Same lockfile precedence as the JS arm of
 * `detectPackageManager`; defaults to npm, which the asset stage always has.
 */
export function detectJsPackageManager(files?: RepoFile[]): string {
  const fileSet = new Set((files ?? []).map((f) => f.name.toLowerCase()));
  if (fileSet.has("pnpm-lock.yaml")) return "pnpm";
  if (fileSet.has("bun.lockb") || fileSet.has("bun.lock")) return "bun";
  if (fileSet.has("yarn.lock")) return "yarn";
  return "npm";
}

// ─── Framework detection rules ───────────────────────────────────────────────

interface FrameworkRule {
  stack: StackId;
  /** Override for stacks where a marker file alone is not enough (e.g. Rails needs Gemfile AND bin/rails). */
  fileMatch?: (fs: Set<string>) => boolean;
  /** Override the dep gate (e.g. Vue needs `vue` AND `!nuxt`). */
  depMatch?: (deps: Record<string, string>) => boolean;
  /** Override the content gate. By default content patterns from STACKS.detection.contentPatterns are used. */
  contentMatch?: (fileContents: Record<string, string>) => boolean;
}

/** True if any of the stack's rootMarkers exist in the file set (lowercased). */
function hasAnyRootMarker(detection: StackDetection | undefined, fileSet: Set<string>): boolean {
  const markers = detection?.rootMarkers;
  if (!markers || markers.length === 0) return false;
  for (const marker of markers) {
    if (fileSet.has(marker.toLowerCase())) return true;
  }
  return false;
}

/**
 * A repo with a NON-JS backend framework at its root that ALSO ships a Vite/
 * asset frontend must detect as the BACKEND, not as a bare Vite SPA. Stock
 * scaffolds do exactly this: `laravel new` (v9+) includes vite.config.js + a
 * package.json, which otherwise shadows Laravel — the deploy then lands on the
 * `vite` stack with an empty start command and is refused. Restricted to
 * unambiguous non-JS backends (PHP/Python/Ruby/Elixir) so a pure-JS Vite app is
 * untouched and a Go/Rust monorepo with a JS frontend isn't flipped. #231
 */
function hasBackendMarker(fileSet: Set<string>): boolean {
  return (
    fileSet.has("composer.json") || // Laravel / Symfony (PHP)
    fileSet.has("artisan") || // Laravel
    fileSet.has("manage.py") || // Django (Python)
    fileSet.has("gemfile") || // Rails (Ruby)
    fileSet.has("mix.exs") // Phoenix (Elixir)
  );
}

/** True if any of the stack's deps appears in the dep map. */
function hasAnyDep(detection: StackDetection | undefined, deps: Record<string, string>): boolean {
  const list = detection?.deps;
  if (!list || list.length === 0) return false;
  for (const name of list) {
    if (deps[name]) return true;
  }
  return false;
}

/** True if any of the stack's contentPatterns matches the relevant file content. */
function hasAnyContentMatch(detection: StackDetection | undefined, fileContents: Record<string, string>): boolean {
  const patterns = detection?.contentPatterns;
  if (!patterns) return false;
  for (const [name, source] of Object.entries(patterns)) {
    const content = fileContents[name.toLowerCase()];
    if (!content) continue;
    if (new RegExp(source, "i").test(content)) return true;
  }
  return false;
}

/**
 * Priority-ordered detection rules. Each entry resolves to:
 *   fileMatch = explicit override OR `hasAnyRootMarker(stack.detection)`
 *   depMatch  = explicit override OR `hasAnyDep(stack.detection)`
 *   contentMatch = explicit override OR `hasAnyContentMatch(stack.detection)`
 *
 * Ordering matters: frontend/fullstack frameworks come before generic backend
 * ones because (for instance) a Next.js project also has Express in transitive
 * deps. When a stack only needs default matchers, list just `{ stack: "..." }`.
 */
const FRAMEWORK_RULES: FrameworkRule[] = [
  // ── Frontend / Fullstack JS (check first - they may also have backend deps) ──
  { stack: "nextjs" },
  { stack: "nuxt" },
  { stack: "sveltekit" },
  { stack: "astro" },
  { stack: "remix" },
  // TanStack Start is Vite-based and often ships vite.config.* — must win over
  // the generic vite SPA rule so imports get fullstack defaults (.output server)
  // instead of static Vite (empty start). #400
  { stack: "tanstack-start" },
  { stack: "angular" },
  { stack: "gatsby" },
  // Vite matches on its own root markers, but a backend framework (Laravel/
  // Symfony/Django/Rails/Phoenix) shipping a Vite asset frontend must fall
  // through to its own rule below — otherwise stock `laravel new` detects as a
  // bare Vite SPA (empty start command → deploy refused). Veto the Vite match
  // when a backend marker is present. #231
  { stack: "vite", fileMatch: (fs) => hasAnyRootMarker(STACKS.vite.detection, fs) && !hasBackendMarker(fs) },
  // CRA has no durable file marker - depMatch alone is authoritative.
  {
    stack: "cra",
    fileMatch: (fs) => fs.has("package.json"),
  },
  // Vue CLI: deps gate excludes Nuxt (which also depends on vue).
  {
    stack: "vue",
    depMatch: (d) => !!d.vue && !d.nuxt,
  },

  // ── Backend JS/TS (check before generic "node") ──
  { stack: "nestjs" },
  { stack: "adonis" },
  {
    stack: "elysia",
    fileMatch: (fs) => fs.has("package.json"),
  },
  {
    stack: "hono",
    fileMatch: (fs) => fs.has("package.json"),
  },
  {
    stack: "fastify",
    fileMatch: (fs) => fs.has("package.json"),
  },
  {
    stack: "koa",
    fileMatch: (fs) => fs.has("package.json"),
  },
  {
    stack: "express",
    fileMatch: (fs) => fs.has("package.json"),
  },

  // ── Python frameworks ────────────────────────────────────────────────────
  { stack: "django" },
  { stack: "flask" },
  { stack: "fastapi" },

  // ── Go ───────────────────────────────────────────────────────────────────
  { stack: "gin" },
  { stack: "fiber" },
  { stack: "echo" },
  {
    stack: "go",
    fileMatch: (fs) => fs.has("go.mod") || fs.has("main.go"),
  },

  // ── Rust ─────────────────────────────────────────────────────────────────
  { stack: "actix" },
  { stack: "axum" },
  { stack: "rocket" },
  { stack: "rust" },

  // ── Ruby ─────────────────────────────────────────────────────────────────
  // Rails: Gemfile AND (bin/rails OR config/routes.rb). Encoded as a conjunction.
  {
    stack: "rails",
    fileMatch: (fs) => fs.has("gemfile") && (fs.has("config/routes.rb") || fs.has("bin/rails")),
  },
  { stack: "sinatra" },

  // ── PHP ──────────────────────────────────────────────────────────────────
  { stack: "laravel" },
  // Symfony needs both composer.json AND symfony.lock - conjunction.
  {
    stack: "symfony",
    fileMatch: (fs) => fs.has("composer.json") && fs.has("symfony.lock"),
  },

  // ── Java / Kotlin ──────────────────────────────────────────────────────────
  { stack: "springboot" },
  { stack: "quarkus" },
  // Kotlin comes after Spring/Quarkus: a Kotlin Spring Boot project matches
  // `springboot` first (its content pattern wins), so this only catches plain
  // Kotlin/JVM services.
  { stack: "kotlin" },

  // ── C# / .NET ────────────────────────────────────────────────────────────
  // Blazor WASM: a .csproj that references the WebAssembly package. There's no
  // .csproj dependency parser, so scan the project file's content directly
  // (dep-gate can't see PackageReferences the way package.json deps are parsed).
  {
    stack: "blazor",
    fileMatch: (fs) => {
      for (const name of fs) if (name.endsWith(".csproj")) return true;
      return false;
    },
    contentMatch: (fc) =>
      Object.entries(fc).some(
        ([name, content]) =>
          name.endsWith(".csproj") && /Microsoft\.AspNetCore\.Components\.WebAssembly/i.test(content),
      ),
  },
  // .NET: any project/solution file suffix.
  {
    stack: "dotnet",
    fileMatch: (fs) => {
      for (const name of fs) {
        if (name.endsWith(".csproj") || name.endsWith(".fsproj") || name.endsWith(".sln")) {
          return true;
        }
      }
      return false;
    },
  },

  // ── Elixir ───────────────────────────────────────────────────────────────
  // Phoenix needs mix.exs AND (lib OR config/config.exs) - conjunction.
  {
    stack: "phoenix",
    fileMatch: (fs) => fs.has("mix.exs") && (fs.has("lib") || fs.has("config/config.exs")),
  },

  // ── Generic Python (catch-all - after specific Python frameworks) ────────
  { stack: "python" },

  // ── Docker Compose (check before single Dockerfile) ──────────────────────
  { stack: "docker-compose" },

  // ── Dockerfile (single container) ────────────────────────────────────────
  { stack: "docker" },

  // ── Static site (no package.json / manifest at all) ──────────────────────
  {
    stack: "static",
    fileMatch: (fs) => fs.has("index.html") && !fs.has("package.json"),
  },

  // ── Generic Node.js (catch-all for JS) ───────────────────────────────────
  {
    stack: "node",
    fileMatch: (fs) =>
      fs.has("package.json") || fs.has("server.js") || fs.has("app.js") || fs.has("index.js"),
  },
];

// ─── Main detection ──────────────────────────────────────────────────────────
//
// Manifest parsing and port detection live in `@repo/core/languages/` - one
// file per language family. The detector iterates that registry to merge deps
// from every present manifest and resolve a default port. Adding a language is
// one new file under packages/core/src/languages/ + a registry entry there.

export function detectStack(
  files: RepoFile[],
  packageJson?: Record<string, unknown>,
  fileContents?: Record<string, string>,
): StackResult {
  const fileSet = new Set(files.map((f) => f.name.toLowerCase()));

  // Normalize file content keys to lowercase for consistent lookups.
  const fc: Record<string, string> = {};
  if (fileContents) {
    for (const [k, v] of Object.entries(fileContents)) fc[k.toLowerCase()] = v;
  }

  // Merge deps: JS deps come from the parsed package.json, the rest come from
  // language-specific manifest parsers via the registry. The JS detector's
  // `parseManifest` would also work here, but we already have the parsed object
  // on hand so we skip the re-parse and feed the deps in directly.
  const deps: Record<string, string> = {
    ...((packageJson?.dependencies as Record<string, string>) ?? {}),
    ...((packageJson?.devDependencies as Record<string, string>) ?? {}),
    ...collectDependencies(fc),
  };

  let matched: StackId = "unknown";

  for (const rule of FRAMEWORK_RULES) {
    const detection = (STACKS[rule.stack] as StackDefinition).detection;

    // File gate: explicit override wins; otherwise any rootMarker in the file set.
    const fileOk = rule.fileMatch
      ? rule.fileMatch(fileSet)
      : hasAnyRootMarker(detection, fileSet);
    if (!fileOk) continue;

    // Gate sources: a rule has gates if it overrides depMatch/contentMatch OR
    // the stack registers deps/contentPatterns. A stack with neither passes
    // straight through on file match alone.
    const hasDepGate = !!rule.depMatch || (detection?.deps?.length ?? 0) > 0;
    const hasContentGate = !!rule.contentMatch || !!detection?.contentPatterns;
    if (!hasDepGate && !hasContentGate) {
      matched = rule.stack;
      break;
    }

    const depOk = rule.depMatch
      ? rule.depMatch(deps)
      : hasAnyDep(detection, deps);
    const contentOk = rule.contentMatch
      ? rule.contentMatch(fc)
      : hasAnyContentMatch(detection, fc);
    if (depOk || contentOk) {
      matched = rule.stack;
      break;
    }
  }

  const pm = detectPackageManager(files, packageJson as Record<string, unknown> & {
    packageManager?: string;
    scripts?: Record<string, string>;
    engines?: Record<string, string>;
  }, fc);

  const stackDef = STACKS[matched] as StackDefinition;

  let startCommand = getStartCommand(pm, matched, packageJson);
  let productionPaths = stackDef.productionPaths ? [...stackDef.productionPaths] : [];

  // Rust: the binary is named after the crate, not a literal "app". Derive it
  // from Cargo.toml so start + productionPaths point at the real artifact.
  if (stackDef.language === "rust") {
    const bin = parseCargoBinaryName(fc["cargo.toml"]);
    if (bin) {
      startCommand = `./target/release/${bin}`;
      productionPaths = [`target/release/${bin}`];
    }
  }

  // .NET: the published assembly is named after the project, not "app". Derive
  // it from the .csproj filename so the start command runs the real DLL. Blazor
  // (static, empty start) is skipped by the truthy-startCommand guard.
  if (stackDef.language === "csharp" && startCommand) {
    const assembly = parseDotnetAssemblyName(files);
    if (assembly) {
      startCommand = `ASPNETCORE_URLS=http://0.0.0.0:$PORT dotnet publish/${assembly}.dll`;
    }
  }

  // Elixir/Phoenix: the mix release is named after the `app` in mix.exs, not a
  // literal "app". Derive it so the start command runs the real release binary.
  // productionPaths stays `_build/prod/rel` (the whole release tree is copied).
  if (stackDef.language === "elixir" && startCommand) {
    const release = parseMixReleaseName(fc["mix.exs"]);
    if (release) {
      startCommand = `_build/prod/rel/${release}/bin/${release} start`;
    }
  }

  // A Dockerfile owns its own build — the runtime builds straight from it
  // (requireRepositoryDockerfile), so nothing is synthesized around it.
  // buildCommand/startCommand already come out empty via the registry defaults
  // on the `docker` stack, but installCommand is derived from the package
  // manager alone, which has no way to know that. A Dockerfile sub-app that
  // also carries a package.json for workspace membership (the Railway-style
  // monorepo layout) would otherwise be handed a bogus `npm i --force`.
  const projectType = getProjectType(matched);

  const result: StackResult = {
    stack: matched,
    projectType,
    category: stackDef.category,
    dependencies: deps,
    packageManager: pm,
    installCommand: projectType === "docker" ? "" : getInstallCommand(pm),
    buildCommand: getBuildCommand(pm, matched, packageJson, files),
    startCommand,
    buildImage: getBuildImage(matched, pm),
    outputDirectory: OUTPUT_DIRECTORIES[matched] ?? "dist",
    productionPaths,
    port: detectPortFromLanguages({ packageJson, fileContents: fc }) ?? stackDef.defaultPort,
  };

  // Fold metadata (vercel.json / render.yaml / …) over heuristic detection so a
  // repo that already tells a PaaS how to build/run it deploys the same way here.
  return applyMetadataOverrides(result, parseDeploymentMetadata(fc));
}

// ─── Metadata overrides (vercel.json / render.yaml / …) ──────────────────────

/** Non-empty string guard for command/dir fields. */
function isSet(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Fold normalized deployment metadata over a detected StackResult.
 *
 * Precedence, per source, field by field:
 *   - authoritative source (vercel): its value overrides the detected default;
 *   - `fillOnly` source (render): its value applies only where detection was empty;
 *   - `nonLocal` source (a root vercel.json that `cd`s into a subdir): its
 *     build-shaping fields are skipped entirely - they describe another
 *     directory's build, not this one's.
 *
 * A `framework` hint reclassifies the stack (category/projectType/image/output/
 * port/productionPaths) from the registry while preserving detected commands
 * unless the metadata overrides them.
 */
export function applyMetadataOverrides(
  result: StackResult,
  metadataList: DeploymentMetadata[],
): StackResult {
  let out = result;

  for (const meta of metadataList) {
    // A nonLocal file's build/install/output/framework all pertain to a
    // different directory - ignore them here (rewrites are handled elsewhere).
    if (meta.nonLocal) continue;

    const takeOver = (current: string, next: string | undefined): string => {
      if (!isSet(next)) return current;
      if (meta.fillOnly && isSet(current)) return current;
      return next;
    };

    if (isSet(meta.framework) && STACK_IDS.includes(meta.framework as StackId)) {
      out = applyFrameworkOverride(out, meta.framework as StackId);
    }

    out = {
      ...out,
      installCommand: takeOver(out.installCommand, meta.installCommand),
      buildCommand: takeOver(out.buildCommand, meta.buildCommand),
      outputDirectory: takeOver(out.outputDirectory, meta.outputDirectory),
      startCommand: takeOver(out.startCommand, meta.startCommand),
    };
  }

  // Vercel "Output Directory" semantics: an explicit outputDirectory on a
  // non-server project means "build, then serve that folder as static" - exactly
  // like Vercel's default (Other framework) preset. A dev `start` script
  // (webpack-dev-server, `vite`) is irrelevant to production static serving, so
  // we drop it → the deploy runs the build and serves the output as static.
  // Genuine server frameworks (Next SSR, Express, …) keep their server shape.
  const declaresOutputDir = metadataList.some((m) => !m.nonLocal && isSet(m.outputDirectory));
  if (declaresOutputDir && !isTrueServerStack(out)) {
    out = classifyAsStaticOutput(out);
  }

  return out;
}

/**
 * A stack that inherently needs a long-running process to serve (SSR frameworks,
 * backends). Generic `node`/`unknown` are NOT true servers - an ambiguous repo
 * with a dev `start` script but an explicit build output is static (the output
 * directory is the authoritative signal). Frontend/static stacks are never servers.
 */
function isTrueServerStack(result: StackResult): boolean {
  if (result.stack === "node" || result.stack === "unknown") return false;
  return result.category === "backend" || result.category === "fullstack";
}

/**
 * Force a static build+serve shape: keep a frontend framework as-is (just ensure
 * no server command), otherwise fall back to the generic `static` stack. The
 * caller's metadata buildCommand/outputDirectory have already been applied and
 * are preserved; we only clear the (dev) start command so the project deploys as
 * static output rather than a long-running server.
 */
function classifyAsStaticOutput(result: StackResult): StackResult {
  if (result.category === "frontend" || result.category === "static") {
    return { ...result, startCommand: "" };
  }
  return {
    ...result,
    stack: "static",
    category: "static",
    projectType: getProjectType("static"),
    startCommand: "",
    buildImage: getBuildImage("static", result.packageManager),
    productionPaths: [],
  };
}

/**
 * Reclassify a StackResult to an explicitly-declared framework. Adopts the
 * framework's registry classification (category/projectType/image/output/
 * productionPaths) and its default port when the current port is still the old
 * stack's default. Commands are left to the detector / other metadata fields.
 */
function applyFrameworkOverride(result: StackResult, framework: StackId): StackResult {
  if (framework === result.stack) return result;

  const oldDef = STACKS[result.stack] as StackDefinition;
  const newDef = STACKS[framework] as StackDefinition;

  return {
    ...result,
    stack: framework,
    projectType: getProjectType(framework),
    category: newDef.category,
    buildImage: getBuildImage(framework, result.packageManager),
    outputDirectory: OUTPUT_DIRECTORIES[framework] ?? result.outputDirectory,
    productionPaths: newDef.productionPaths ? [...newDef.productionPaths] : result.productionPaths,
    port: result.port === oldDef.defaultPort ? newDef.defaultPort : result.port,
  };
}

// ─── Default commands ────────────────────────────────────────────────────────

/** Install command per package manager */
export function getInstallCommand(pm: string): string {
  switch (pm) {
    case "pnpm": return "pnpm install";
    case "yarn": return "yarn install";
    case "bun": return "bun install";
    case "npm": return "npm i --force";
    case "go": return "go mod download";
    case "cargo": return "";  // cargo build handles deps
    case "pip": return "pip install -r requirements.txt";
    case "uv": return "uv sync";
    case "poetry": return "poetry install --no-root";
    case "pipenv": return "pipenv install --deploy";
    case "bundler": return "bundle install";
    case "composer": return "composer install --no-dev --optimize-autoloader";
    case "maven": return "mvn dependency:resolve";
    case "gradle": return "gradle dependencies";
    case "dotnet": return "dotnet restore";
    case "mix": return "mix deps.get";
    default: return "";
  }
}

/**
 * Resolve the npm-script runner verb for a package manager.
 * `bun build` / `bun start` are NOT the bundler / npm-script - they're separate Bun
 * subcommands. yarn and pnpm fall back to running scripts when given a bare name,
 * but bun and npm don't, so both need the explicit `run`.
 */
function scriptRunner(pm: string): string {
  if (pm === "npm" || pm === "bun") return `${pm} run`;
  return pm;
}

/** Case-insensitive check for a file basename in the repo listing. */
function hasFile(files: RepoFile[] | undefined, name: string): boolean {
  return !!files?.some((f) => f.name.toLowerCase() === name);
}

/**
 * Python install command per package manager. uv/poetry/pipenv aren't on the
 * python:*-slim build image, so pip-install them first — keeping the build
 * self-contained on the default image and on bare metal (both ship pip).
 */
function pythonInstallCommand(pm: string): string {
  switch (pm) {
    case "uv": return "pip install uv && uv sync";
    case "poetry": return "pip install poetry && poetry install --no-root";
    case "pipenv": return "pip install pipenv && pipenv install --deploy";
    default: return "pip install -r requirements.txt";
  }
}

/**
 * JVM build command. Maven builds use the `mvn` bundled in the build image (or
 * `./mvnw`); Gradle builds prefer the `./gradlew` wrapper — the image ships only
 * a JDK, not a `gradle` binary — and fall back to `gradle` on bare metal.
 */
function jvmBuildCommand(pm: string, files?: RepoFile[]): string {
  if (pm === "gradle") {
    return `${hasFile(files, "gradlew") ? "./gradlew" : "gradle"} build -x test`;
  }
  return `${hasFile(files, "mvnw") ? "./mvnw" : "mvn"} clean package -DskipTests`;
}

/**
 * Derive the Rust binary name from Cargo.toml: an explicit `[[bin]] name` wins,
 * else the `[package] name`. Returns null when neither is present, so the caller
 * keeps the registry's literal "app" default.
 */
function parseCargoBinaryName(content?: string): string | null {
  if (!content) return null;
  const bin = content.match(/\[\[bin\]\][\s\S]*?\bname\s*=\s*["']([^"']+)["']/);
  if (bin) return bin[1];
  const pkg = content.match(/\[package\][\s\S]*?\bname\s*=\s*["']([^"']+)["']/);
  if (pkg) return pkg[1];
  return null;
}

/**
 * Derive the .NET assembly name from the project's `*.csproj`/`*.fsproj`
 * filename — the published DLL defaults to the project name. Returns null when
 * no project file is present, so the caller keeps the registry's "app" fallback.
 */
function parseDotnetAssemblyName(files: RepoFile[]): string | null {
  for (const f of files) {
    const lower = f.name.toLowerCase();
    if (lower.endsWith(".csproj") || lower.endsWith(".fsproj")) {
      return f.name.slice(0, f.name.lastIndexOf("."));
    }
  }
  return null;
}

/**
 * Derive the Elixir mix release name from `mix.exs`: the `app: :name` atom in the
 * `project` block, which the default `mix release` names the release after.
 * Returns null when absent, so the caller keeps the registry's literal "app".
 */
function parseMixReleaseName(content?: string): string | null {
  if (!content) return null;
  const app = content.match(/\bapp:\s*:([a-zA-Z_][a-zA-Z0-9_]*)/);
  return app ? app[1] : null;
}

/** Build command - prefers project scripts, then falls back to registry defaults */
export function getBuildCommand(
  pm: string,
  stack: StackId,
  packageJson?: Record<string, unknown>,
  files?: RepoFile[],
): string {
  const scripts = (packageJson?.scripts ?? {}) as Record<string, string>;
  const runner = scriptRunner(pm);

  // JS/TS: if the project has a build script, always prefer it
  if (scripts.build && ["npm", "yarn", "pnpm", "bun"].includes(pm)) {
    return `${runner} build`;
  }

  const lang = STACKS[stack].language;

  // PHP: the install step is `composer install`, so the BUILD step is the asset
  // pipeline — a Laravel/Vite or Symfony/Encore app ships CSS/JS that has to be
  // compiled or it deploys with no styling at all. Emitted as a real command
  // (rather than hidden in the Dockerfile) so it shows up in the wizard and can
  // be edited; the recipe runs it in a Node stage, since php:*-cli has no node.
  // Empty when the repo has no JS build — most Symfony APIs, plain PHP.
  if (lang === "php") {
    if (!scripts.build) return "";
    const jsPm = detectJsPackageManager(files);
    return `${getInstallCommand(jsPm)} && ${scriptRunner(jsPm)} build`;
  }

  // Python: install per detected package manager; Django also collects static.
  if (lang === "python") {
    const install = pythonInstallCommand(pm);
    return stack === "django" ? `${install} && python manage.py collectstatic --noinput` : install;
  }

  // JVM: Maven vs Gradle, wrapper-aware.
  if (lang === "java") {
    return jvmBuildCommand(pm, files);
  }

  // Fall back to the registry default
  return STACKS[stack].defaultBuildCommand;
}

/** Start command - prefers project scripts, then falls back to registry defaults */
export function getStartCommand(pm: string, stack: StackId, packageJson?: Record<string, unknown>): string {
  const scripts = (packageJson?.scripts ?? {}) as Record<string, string>;
  const runner = scriptRunner(pm);

  // JS/TS: prefer explicit start script
  if (scripts.start && ["npm", "yarn", "pnpm", "bun"].includes(pm)) {
    return `${runner} start`;
  }

  // Main field in package.json
  const main = packageJson?.main as string | undefined;
  const lang = STACKS[stack].language;
  if (main && (lang === "javascript" || lang === "typescript")) {
    return `node ${main}`;
  }

  // JVM Gradle output lands in build/libs; Maven keeps the registry default
  // (target/*.jar for Spring Boot, quarkus-run.jar for Quarkus).
  if (lang === "java" && pm === "gradle") {
    return "java -jar build/libs/*.jar";
  }

  // Fall back to the registry default
  return STACKS[stack].defaultStartCommand;
}
