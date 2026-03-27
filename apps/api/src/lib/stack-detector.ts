/**
 * Stack detector — detects framework, package manager, and build settings
 * from a repository's file listing and package.json / manifest files.
 *
 * All categories, output directories, and default commands are derived from
 * the STACKS registry in @repo/core — no duplication.
 *
 * Supports:
 *   JS/TS:   Next.js, Nuxt, SvelteKit, Astro, Vite, Angular, Gatsby, Remix,
 *            CRA, Vue, Express, Fastify, Hono, NestJS, Koa, AdonisJS, Elysia
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

import { STACKS, OUTPUT_DIRECTORIES, getProjectType, getBuildImage, type StackId, type ProjectType, type StackDefinition } from "@repo/core";

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

/** Manifest filenames callers should try to read and pass to detectStack */
export const MANIFEST_FILES = [
  "requirements.txt",
  "pyproject.toml",
  "Pipfile",
  "go.mod",
  "Cargo.toml",
  "Gemfile",
  "composer.json",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "mix.exs",
  "Dockerfile",
] as const;

// ─── Package manager detection ───────────────────────────────────────────────

export function detectPackageManager(
  files: RepoFile[],
  packageJson?: { packageManager?: string; scripts?: Record<string, string>; engines?: Record<string, string> },
): string {
  const fileSet = new Set(files.map((f) => f.name.toLowerCase()));

  // ── Non-JS languages (check manifests first) ──
  if (fileSet.has("go.mod")) return "go";
  if (fileSet.has("cargo.toml")) return "cargo";
  if (fileSet.has("pyproject.toml")) return "uv";
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

// ─── Framework detection rules ───────────────────────────────────────────────

interface FrameworkRule {
  stack: StackId;
  fileMatch: (fs: Set<string>) => boolean;
  depMatch?: (deps: Record<string, string>) => boolean;
  /** Match against file contents map (lowercase filename → content) */
  contentMatch?: (fileContents: Record<string, string>) => boolean;
}

/**
 * Rules are ordered by specificity — most specific first.
 * Frontend/fullstack frameworks are checked before generic backend ones
 * because a Next.js project also has express as a transitive dep.
 */
const FRAMEWORK_RULES: FrameworkRule[] = [
  // ── Frontend / Fullstack JS (check first — they may also have backend deps) ──

  {
    stack: "nextjs",
    fileMatch: (fs) =>
      fs.has("next.config.js") || fs.has("next.config.mjs") || fs.has("next.config.ts"),
    depMatch: (d) => !!d.next,
  },
  {
    stack: "nuxt",
    fileMatch: (fs) =>
      fs.has("nuxt.config.js") || fs.has("nuxt.config.ts") || fs.has("nuxt.config.mjs"),
    depMatch: (d) => !!d.nuxt || !!d["@nuxt/core"],
  },
  {
    stack: "sveltekit",
    fileMatch: (fs) => fs.has("svelte.config.js") || fs.has("svelte.config.mjs"),
    depMatch: (d) => !!d.svelte || !!d["@sveltejs/kit"],
  },
  {
    stack: "astro",
    fileMatch: (fs) =>
      fs.has("astro.config.mjs") || fs.has("astro.config.js") || fs.has("astro.config.ts"),
    depMatch: (d) => !!d.astro,
  },
  {
    stack: "remix",
    fileMatch: (fs) =>
      fs.has("remix.config.js") || fs.has("remix.config.ts") || fs.has("app/root.tsx"),
    depMatch: (d) => !!d["@remix-run/react"] || !!d["@remix-run/node"] || !!d.remix,
  },
  {
    stack: "angular",
    fileMatch: (fs) => fs.has("angular.json"),
    depMatch: (d) => !!d["@angular/core"],
  },
  {
    stack: "gatsby",
    fileMatch: (fs) => fs.has("gatsby-config.js") || fs.has("gatsby-config.ts"),
    depMatch: (d) => !!d.gatsby,
  },
  {
    stack: "vite",
    fileMatch: (fs) =>
      fs.has("vite.config.js") || fs.has("vite.config.ts") || fs.has("vite.config.mjs"),
    depMatch: (d) => !!d.vite,
  },
  {
    stack: "cra",
    fileMatch: (fs) => fs.has("public") && fs.has("src") && fs.has("package.json"),
    depMatch: (d) => !!d["react-scripts"],
  },
  {
    stack: "vue",
    fileMatch: (fs) => fs.has("vue.config.js") || fs.has("vue.config.ts"),
    depMatch: (d) => !!d.vue && !d.nuxt,
  },

  // ── Backend JS/TS (check before generic "node") ──

  {
    stack: "nestjs",
    fileMatch: (fs) => fs.has("nest-cli.json") || fs.has("tsconfig.build.json"),
    depMatch: (d) => !!d["@nestjs/core"],
  },
  {
    stack: "adonis",
    fileMatch: (fs) => fs.has("ace.js") || fs.has(".adonisrc.json") || fs.has("adonisrc.ts"),
    depMatch: (d) => !!d["@adonisjs/core"],
  },
  {
    stack: "elysia",
    fileMatch: (fs) => fs.has("package.json"),
    depMatch: (d) => !!d.elysia,
  },
  {
    stack: "hono",
    fileMatch: (fs) => fs.has("package.json"),
    depMatch: (d) => !!d.hono,
  },
  {
    stack: "fastify",
    fileMatch: (fs) => fs.has("package.json"),
    depMatch: (d) => !!d.fastify,
  },
  {
    stack: "koa",
    fileMatch: (fs) => fs.has("package.json"),
    depMatch: (d) => !!d.koa,
  },
  {
    stack: "express",
    fileMatch: (fs) => fs.has("package.json"),
    depMatch: (d) => !!d.express,
  },

  // ── Python ────────────────────────────────────────────────────────────────

  {
    stack: "django",
    fileMatch: (fs) => fs.has("manage.py") || fs.has("django") || fs.has("settings.py"),
  },
  {
    stack: "flask",
    fileMatch: (fs) => fs.has("requirements.txt") || fs.has("pyproject.toml") || fs.has("pipfile"),
    depMatch: (d) => !!d.flask || !!d.Flask,
  },
  {
    stack: "fastapi",
    fileMatch: (fs) => fs.has("requirements.txt") || fs.has("pyproject.toml") || fs.has("pipfile"),
    depMatch: (d) => !!d.fastapi || !!d.FastAPI,
  },

  // ── Go ────────────────────────────────────────────────────────────────────

  {
    stack: "gin",
    fileMatch: (fs) => fs.has("go.mod"),
    // contentMatch can be used later when we parse go.mod
    depMatch: (d) => !!d["github.com/gin-gonic/gin"],
  },
  {
    stack: "fiber",
    fileMatch: (fs) => fs.has("go.mod"),
    depMatch: (d) => !!d["github.com/gofiber/fiber"],
  },
  {
    stack: "echo",
    fileMatch: (fs) => fs.has("go.mod"),
    depMatch: (d) => !!d["github.com/labstack/echo"],
  },
  {
    stack: "go",
    fileMatch: (fs) => fs.has("go.mod") || fs.has("main.go"),
  },

  // ── Rust ──────────────────────────────────────────────────────────────────

  {
    stack: "actix",
    fileMatch: (fs) => fs.has("cargo.toml"),
    depMatch: (d) => !!d["actix-web"],
  },
  {
    stack: "axum",
    fileMatch: (fs) => fs.has("cargo.toml"),
    depMatch: (d) => !!d.axum,
  },
  {
    stack: "rocket",
    fileMatch: (fs) => fs.has("cargo.toml"),
    depMatch: (d) => !!d.rocket,
  },
  {
    stack: "rust",
    fileMatch: (fs) => fs.has("cargo.toml"),
  },

  // ── Ruby ──────────────────────────────────────────────────────────────────

  {
    stack: "rails",
    fileMatch: (fs) => fs.has("gemfile") && (fs.has("config/routes.rb") || fs.has("bin/rails")),
  },
  {
    stack: "sinatra",
    fileMatch: (fs) => fs.has("gemfile"),
    depMatch: (d) => !!d.sinatra,
  },

  // ── PHP ───────────────────────────────────────────────────────────────────

  {
    stack: "laravel",
    fileMatch: (fs) => fs.has("artisan") || fs.has("composer.json"),
    depMatch: (d) => !!d["laravel/framework"],
  },
  {
    stack: "symfony",
    fileMatch: (fs) => fs.has("composer.json") && fs.has("symfony.lock"),
    depMatch: (d) => !!d["symfony/framework-bundle"],
  },

  // ── Java ──────────────────────────────────────────────────────────────────

  {
    stack: "springboot",
    fileMatch: (fs) =>
      fs.has("pom.xml") || fs.has("build.gradle") || fs.has("build.gradle.kts"),
    depMatch: (d) =>
      !!d["org.springframework.boot:spring-boot-starter-web"] || !!d["spring-boot"],
    contentMatch: (fc) =>
      /spring[-.]boot/i.test((fc["pom.xml"] ?? "") + (fc["build.gradle"] ?? "") + (fc["build.gradle.kts"] ?? "")),
  },
  {
    stack: "quarkus",
    fileMatch: (fs) =>
      fs.has("pom.xml") || fs.has("build.gradle") || fs.has("build.gradle.kts"),
    depMatch: (d) => !!d["io.quarkus:quarkus-core"] || !!d.quarkus,
    contentMatch: (fc) =>
      /io\.quarkus/i.test((fc["pom.xml"] ?? "") + (fc["build.gradle"] ?? "") + (fc["build.gradle.kts"] ?? "")),
  },

  // ── C# / .NET ─────────────────────────────────────────────────────────────

  {
    stack: "blazor",
    fileMatch: (fs) => {
      for (const name of fs) if (name.endsWith(".csproj")) return true;
      return false;
    },
    depMatch: (d) => !!d["Microsoft.AspNetCore.Components.WebAssembly"],
  },
  {
    stack: "dotnet",
    fileMatch: (fs) => {
      for (const name of fs) {
        if (name.endsWith(".csproj") || name.endsWith(".fsproj") || name.endsWith(".sln"))
          return true;
      }
      return false;
    },
  },

  // ── Elixir ────────────────────────────────────────────────────────────────

  {
    stack: "phoenix",
    fileMatch: (fs) => fs.has("mix.exs") && (fs.has("lib") || fs.has("config/config.exs")),
    depMatch: (d) => !!d.phoenix,
  },

  // ── Generic Python (catch-all — after specific Python frameworks) ─────────

  {
    stack: "python",
    fileMatch: (fs) =>
      fs.has("requirements.txt") || fs.has("pyproject.toml") || fs.has("pipfile") || fs.has("setup.py"),
  },

  // ── Docker Compose (check before single Dockerfile) ───────────────────────

  {
    stack: "docker-compose",
    fileMatch: (fs) => fs.has("docker-compose.yml") || fs.has("docker-compose.yaml") || fs.has("compose.yml") || fs.has("compose.yaml"),
  },

  // ── Dockerfile (single container) ─────────────────────────────────

  {
    stack: "docker",
    fileMatch: (fs) => fs.has("dockerfile"),
  },

  // ── Static site (no package.json / manifest at all) ───────────────────────

  {
    stack: "static",
    fileMatch: (fs) => fs.has("index.html") && !fs.has("package.json"),
  },

  // ── Generic Node.js (catch-all for JS) ────────────────────────────────────

  {
    stack: "node",
    fileMatch: (fs) =>
      fs.has("package.json") || fs.has("server.js") || fs.has("app.js") || fs.has("index.js"),
  },
];

// ─── Port detection from package.json scripts ────────────────────────────────

/**
 * Scan package.json scripts for explicit --port / -p flags.
 * Returns the port number if found, or null to fall back to framework default.
 */
function detectPortFromScripts(packageJson?: Record<string, unknown>): number | null {
  const scripts = (packageJson?.scripts ?? {}) as Record<string, string>;

  // Check start, dev, serve, preview — in priority order
  for (const key of ["start", "dev", "serve", "preview"]) {
    const script = scripts[key];
    if (!script) continue;

    // Match --port 8080, --port=8080, -p 8080, -p=8080
    const match = script.match(/(?:--port|--PORT|-p)[\s=](\d{2,5})\b/);
    if (match) {
      const port = parseInt(match[1], 10);
      if (port > 0 && port <= 65535) return port;
    }
  }

  return null;
}

// ─── Manifest parsers ────────────────────────────────────────────────────────

/** Parse Python requirements.txt into a deps map (lowercase keys) */
function parseRequirementsTxt(content: string): Record<string, string> {
  const deps: Record<string, string> = {};
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("-")) continue;
    const m = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/);
    if (m) deps[m[1].toLowerCase().replace(/-/g, "_")] = line.slice(m[1].length) || "*";
  }
  return deps;
}

/** Parse pyproject.toml — PEP 621 [project].dependencies + Poetry [tool.poetry.dependencies] */
function parsePyprojectToml(content: string): Record<string, string> {
  const deps: Record<string, string> = {};

  // PEP 621: dependencies = ["flask>=2.0", "sqlalchemy"]
  const pep621 = content.match(/\[project\][^[]*?dependencies\s*=\s*\[([\s\S]*?)\]/);
  if (pep621) {
    const items = pep621[1].matchAll(/["']([^"']+)["']/g);
    for (const item of items) {
      const m = item[1].match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/);
      if (m) deps[m[1].toLowerCase().replace(/-/g, "_")] = "*";
    }
  }

  // Poetry: [tool.poetry.dependencies]
  const poetry = content.match(/\[tool\.poetry\.dependencies\]([\s\S]*?)(?=\[|$)/);
  if (poetry) {
    for (const line of poetry[1].split("\n")) {
      const m = line.match(/^([A-Za-z0-9][A-Za-z0-9_-]*)\s*=/);
      if (m && m[1] !== "python") deps[m[1].toLowerCase().replace(/-/g, "_")] = "*";
    }
  }

  // Optional dependencies groups: [project.optional-dependencies.*]
  const optGroups = content.matchAll(/\[project\.optional-dependencies\.[^\]]+\]([\s\S]*?)(?=\[|$)/g);
  for (const group of optGroups) {
    const items = group[1].matchAll(/["']([^"']+)["']/g);
    for (const item of items) {
      const m = item[1].match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/);
      if (m) deps[m[1].toLowerCase().replace(/-/g, "_")] = "*";
    }
  }

  return deps;
}

/** Parse Pipfile [packages] + [dev-packages] sections */
function parsePipfile(content: string): Record<string, string> {
  const deps: Record<string, string> = {};
  const sections = content.matchAll(/\[(packages|dev-packages)\]([\s\S]*?)(?=\[|$)/g);
  for (const section of sections) {
    for (const line of section[2].split("\n")) {
      const m = line.match(/^([A-Za-z0-9][A-Za-z0-9_-]*)\s*=/);
      if (m) deps[m[1].toLowerCase().replace(/-/g, "_")] = "*";
    }
  }
  return deps;
}

/** Parse go.mod require blocks into deps map */
function parseGoMod(content: string): Record<string, string> {
  const deps: Record<string, string> = {};
  // Multi-line require blocks
  const blocks = content.matchAll(/require\s*\(([\s\S]*?)\)/g);
  for (const block of blocks) {
    for (const line of block[1].split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("//")) continue;
      const parts = trimmed.split(/\s+/);
      if (parts.length >= 2) {
        deps[parts[0]] = parts[1];
        // Strip major version suffix: github.com/foo/bar/v2 → github.com/foo/bar
        const base = parts[0].replace(/\/v\d+$/, "");
        if (base !== parts[0]) deps[base] = parts[1];
      }
    }
  }
  // Single-line requires
  for (const m of content.matchAll(/^require\s+([\S]+)\s+([\S]+)/gm)) {
    deps[m[1]] = m[2];
    const base = m[1].replace(/\/v\d+$/, "");
    if (base !== m[1]) deps[base] = m[2];
  }
  return deps;
}

/** Parse Cargo.toml [dependencies] / [dev-dependencies] / [build-dependencies] */
function parseCargoToml(content: string): Record<string, string> {
  const deps: Record<string, string> = {};
  const sections = content.matchAll(/\[(?:workspace\.)?(?:dev-|build-)?dependencies\]([\s\S]*?)(?=\[|$)/g);
  for (const section of sections) {
    for (const line of section[1].split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const m = trimmed.match(/^([A-Za-z0-9_-]+)\s*=/);
      if (m) deps[m[1]] = "*";
    }
  }
  return deps;
}

/** Parse Gemfile gem declarations */
function parseGemfile(content: string): Record<string, string> {
  const deps: Record<string, string> = {};
  for (const m of content.matchAll(/gem\s+['"]([^'"]+)['"]/g)) {
    deps[m[1].toLowerCase()] = "*";
  }
  return deps;
}

/** Parse composer.json require + require-dev */
function parseComposerJson(content: string): Record<string, string> {
  try {
    const parsed = JSON.parse(content);
    return { ...(parsed.require ?? {}), ...(parsed["require-dev"] ?? {}) };
  } catch {
    return {};
  }
}

/** Parse Elixir mix.exs deps ({:phoenix, "~> 1.7"}) */
function parseMixExs(content: string): Record<string, string> {
  const deps: Record<string, string> = {};
  for (const m of content.matchAll(/\{:([\w]+),/g)) {
    deps[m[1]] = "*";
  }
  return deps;
}

/** Extract EXPOSE port from Dockerfile */
function parseDockerfilePort(content?: string): number | null {
  if (!content) return null;
  const m = content.match(/^EXPOSE\s+(\d{2,5})/m);
  if (m) {
    const port = parseInt(m[1], 10);
    if (port > 0 && port <= 65535) return port;
  }
  return null;
}

// ─── Main detection ──────────────────────────────────────────────────────────

export function detectStack(
  files: RepoFile[],
  packageJson?: Record<string, unknown>,
  fileContents?: Record<string, string>,
): StackResult {
  const fileSet = new Set(files.map((f) => f.name.toLowerCase()));
  const deps: Record<string, string> = {
    ...((packageJson?.dependencies as Record<string, string>) ?? {}),
    ...((packageJson?.devDependencies as Record<string, string>) ?? {}),
  };

  // Normalize file content keys to lowercase for consistent lookups
  const fc: Record<string, string> = {};
  if (fileContents) {
    for (const [k, v] of Object.entries(fileContents)) fc[k.toLowerCase()] = v;
  }

  // Merge deps from language-specific manifests
  if (fc["requirements.txt"]) Object.assign(deps, parseRequirementsTxt(fc["requirements.txt"]));
  if (fc["pyproject.toml"]) Object.assign(deps, parsePyprojectToml(fc["pyproject.toml"]));
  if (fc["pipfile"]) Object.assign(deps, parsePipfile(fc["pipfile"]));
  if (fc["go.mod"]) Object.assign(deps, parseGoMod(fc["go.mod"]));
  if (fc["cargo.toml"]) Object.assign(deps, parseCargoToml(fc["cargo.toml"]));
  if (fc["gemfile"]) Object.assign(deps, parseGemfile(fc["gemfile"]));
  if (fc["composer.json"]) Object.assign(deps, parseComposerJson(fc["composer.json"]));
  if (fc["mix.exs"]) Object.assign(deps, parseMixExs(fc["mix.exs"]));

  let matched: StackId = "unknown";

  for (const rule of FRAMEWORK_RULES) {
    if (!rule.fileMatch(fileSet)) continue;

    const hasGates = !!(rule.depMatch || rule.contentMatch);
    if (!hasGates) { matched = rule.stack; break; }

    const depOk = rule.depMatch?.(deps) ?? false;
    const contentOk = rule.contentMatch?.(fc) ?? false;
    if (depOk || contentOk) { matched = rule.stack; break; }
  }

  const pm = detectPackageManager(files, packageJson as Record<string, unknown> & {
    packageManager?: string;
    scripts?: Record<string, string>;
    engines?: Record<string, string>;
  });

  const stackDef = STACKS[matched];

  return {
    stack: matched,
    projectType: getProjectType(matched),
    category: stackDef.category,
    dependencies: deps,
    packageManager: pm,
    installCommand: getInstallCommand(pm),
    buildCommand: getBuildCommand(pm, matched, packageJson),
    startCommand: getStartCommand(pm, matched, packageJson),
    buildImage: getBuildImage(matched, pm),
    outputDirectory: OUTPUT_DIRECTORIES[matched] ?? "dist",
    productionPaths: (stackDef as StackDefinition).productionPaths ? [...(stackDef as StackDefinition).productionPaths!] : [],
    port: detectPortFromScripts(packageJson) ?? parseDockerfilePort(fc["dockerfile"]) ?? stackDef.defaultPort,
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

/** Build command — prefers project scripts, then falls back to registry defaults */
function getBuildCommand(pm: string, stack: StackId, packageJson?: Record<string, unknown>): string {
  const scripts = (packageJson?.scripts ?? {}) as Record<string, string>;
  const runner = pm === "npm" ? "npm run" : pm;

  // JS/TS: if the project has a build script, always prefer it
  if (scripts.build && ["npm", "yarn", "pnpm", "bun"].includes(pm)) {
    return `${runner} build`;
  }

  // Fall back to the registry default
  return STACKS[stack].defaultBuildCommand;
}

/** Start command — prefers project scripts, then falls back to registry defaults */
function getStartCommand(pm: string, stack: StackId, packageJson?: Record<string, unknown>): string {
  const scripts = (packageJson?.scripts ?? {}) as Record<string, string>;
  const runner = pm === "npm" ? "npm run" : pm;

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

  // Fall back to the registry default
  return STACKS[stack].defaultStartCommand;
}
