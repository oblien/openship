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

import { STACKS, OUTPUT_DIRECTORIES, type StackId } from "@repo/core";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RepoFile {
  name: string;
  type?: string;
}

export interface StackResult {
  stack: StackId;
  category: string;
  dependencies: Record<string, string>;
  packageManager: string;
  installCommand: string;
  buildCommand: string;
  startCommand: string;
  outputDirectory: string;
}

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
  if (fileSet.has("yarn.lock")) return "yarn";
  if (fileSet.has("bun.lockb") || fileSet.has("bun.lock")) return "bun";
  if (fileSet.has("package-lock.json")) return "npm";

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
  /** Match against text content of specific files (e.g. Cargo.toml) */
  contentMatch?: (content: string) => boolean;
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
  },
  {
    stack: "quarkus",
    fileMatch: (fs) =>
      fs.has("pom.xml") || fs.has("build.gradle") || fs.has("build.gradle.kts"),
    depMatch: (d) => !!d["io.quarkus:quarkus-core"] || !!d.quarkus,
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

  // ── Docker ────────────────────────────────────────────────────────────────

  {
    stack: "docker",
    fileMatch: (fs) => fs.has("dockerfile") || fs.has("docker-compose.yml") || fs.has("docker-compose.yaml"),
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

// ─── Main detection ──────────────────────────────────────────────────────────

export function detectStack(
  files: RepoFile[],
  packageJson?: Record<string, unknown>,
): StackResult {
  const fileSet = new Set(files.map((f) => f.name.toLowerCase()));
  const deps: Record<string, string> = {
    ...((packageJson?.dependencies as Record<string, string>) ?? {}),
    ...((packageJson?.devDependencies as Record<string, string>) ?? {}),
  };

  let matched: StackId = "unknown";

  for (const rule of FRAMEWORK_RULES) {
    if (rule.fileMatch(fileSet)) {
      if (!rule.depMatch || rule.depMatch(deps)) {
        matched = rule.stack;
        break;
      }
    }
  }

  const pm = detectPackageManager(files, packageJson as Record<string, unknown> & {
    packageManager?: string;
    scripts?: Record<string, string>;
    engines?: Record<string, string>;
  });

  const stackDef = STACKS[matched];

  return {
    stack: matched,
    category: stackDef.category,
    dependencies: deps,
    packageManager: pm,
    installCommand: getInstallCommand(pm),
    buildCommand: getBuildCommand(pm, matched, packageJson),
    startCommand: getStartCommand(pm, matched, packageJson),
    outputDirectory: OUTPUT_DIRECTORIES[matched] ?? "dist",
  };
}

// ─── Default commands ────────────────────────────────────────────────────────

/** Install command per package manager */
function getInstallCommand(pm: string): string {
  switch (pm) {
    case "pnpm": return "pnpm install --frozen-lockfile";
    case "yarn": return "yarn install --frozen-lockfile";
    case "bun": return "bun install --frozen-lockfile";
    case "npm": return "npm ci";
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
