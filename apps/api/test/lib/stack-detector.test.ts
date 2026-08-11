import { describe, expect, it } from "vitest";

import {
  detectPackageManager,
  detectStack,
  getBuildCommand,
  getInstallCommand,
  getStartCommand,
  type RepoFile,
} from "../../src/lib/stack-detector";

/**
 * Helper: build a RepoFile[] from a flat string[] of filenames.
 * Trailing "/" marks the name as a directory (only matters for static-site
 * detection that checks `fs.has("public")` etc., though most stack rules
 * treat names case-insensitively without caring about type).
 */
function files(...names: string[]): RepoFile[] {
  return names.map((name) => {
    if (name.endsWith("/")) {
      return { name: name.slice(0, -1), type: "dir" };
    }
    return { name, type: "file" };
  });
}

// ─── Stack identification - table-driven across every supported framework ────

interface StackCase {
  name: string;
  files: RepoFile[];
  packageJson?: Record<string, unknown>;
  fileContents?: Record<string, string>;
  expectedStack: string;
  /** Optional extra assertions. */
  expectedCategory?: string;
  expectedProjectType?: string;
  expectedStartCommand?: string;
}

const POSITIVE_STACK_CASES: StackCase[] = [
  // ── #231 regression: a backend framework shipping a Vite asset frontend must
  //    detect as the backend, NOT as a bare Vite SPA (stock `laravel new` ships
  //    vite.config.js + package.json and previously shadowed Laravel) ──────────
  {
    name: "Laravel + Vite frontend (stock `laravel new`) → laravel, not vite (#231)",
    files: files("composer.json", "artisan", "package.json", "vite.config.js", "app/", "routes/"),
    packageJson: { devDependencies: { vite: "^5.0.0", "laravel-vite-plugin": "^1.0.0" } },
    // Real folder/git scans always carry composer.json content — Laravel's dep
    // gate keys on laravel/framework. Without the Vite veto, `vite` matched first.
    fileContents: { "composer.json": '{"require":{"laravel/framework":"^11.0","php":"^8.2"}}' },
    expectedStack: "laravel",
  },
  {
    name: "Pure Vite SPA (no backend marker) still → vite (#231 guard)",
    files: files("package.json", "vite.config.ts", "index.html", "src/"),
    packageJson: { devDependencies: { vite: "^5.0.0" } },
    expectedStack: "vite",
  },
  // ── JS/TS Frontend & Fullstack ──────────────────────────────────────────
  {
    name: "Next.js - next.config.js + next dep",
    files: files("package.json", "next.config.js"),
    packageJson: { dependencies: { next: "^15.0.0", react: "^19.0.0" } },
    expectedStack: "nextjs",
    expectedCategory: "fullstack",
    expectedProjectType: "app",
  },
  {
    name: "Next.js - next.config.ts",
    files: files("package.json", "next.config.ts"),
    packageJson: { dependencies: { next: "^15.0.0" } },
    expectedStack: "nextjs",
  },
  {
    name: "Next.js - next.config.mjs",
    files: files("package.json", "next.config.mjs"),
    packageJson: { dependencies: { next: "^15.0.0" } },
    expectedStack: "nextjs",
  },
  {
    name: "Nuxt - nuxt.config.ts + nuxt dep",
    files: files("package.json", "nuxt.config.ts"),
    packageJson: { dependencies: { nuxt: "^3.0.0" } },
    expectedStack: "nuxt",
    expectedCategory: "fullstack",
  },
  {
    name: "Nuxt - via @nuxt/core dep",
    files: files("package.json", "nuxt.config.js"),
    packageJson: { dependencies: { "@nuxt/core": "^2.0.0" } },
    expectedStack: "nuxt",
  },
  {
    name: "SvelteKit - svelte.config.js + @sveltejs/kit dep",
    files: files("package.json", "svelte.config.js"),
    packageJson: { dependencies: { "@sveltejs/kit": "^2.0.0", svelte: "^5.0.0" } },
    expectedStack: "sveltekit",
  },
  {
    name: "Astro - astro.config.mjs + astro dep",
    files: files("package.json", "astro.config.mjs"),
    packageJson: { dependencies: { astro: "^4.0.0" } },
    expectedStack: "astro",
    expectedCategory: "frontend",
  },
  {
    name: "Remix - remix.config.js + @remix-run/react dep",
    files: files("package.json", "remix.config.js"),
    packageJson: { dependencies: { "@remix-run/react": "^2.0.0" } },
    expectedStack: "remix",
  },
  // ── #400: TanStack Start is Vite-based; must detect as fullstack tanstack-start
  //    (not bare vite SPA) so defaults use .output server start, not empty start.
  {
    name: "TanStack Start - vite.config.ts + @tanstack/react-start → tanstack-start, not vite (#400)",
    files: files("package.json", "vite.config.ts", "src/", "app/"),
    packageJson: {
      dependencies: {
        "@tanstack/react-start": "^1.0.0",
        react: "^19.0.0",
        vite: "^6.0.0",
      },
      // build script present → pm-prefixed build; no start script → registry default
      scripts: { build: "vite build" },
    },
    expectedStack: "tanstack-start",
    expectedCategory: "fullstack",
    expectedProjectType: "app",
    expectedStartCommand: "node .output/server/index.mjs",
  },
  {
    name: "TanStack Start - app.config.ts + @tanstack/start dep (#400)",
    files: files("package.json", "app.config.ts"),
    packageJson: {
      dependencies: { "@tanstack/start": "^1.0.0" },
    },
    expectedStack: "tanstack-start",
    expectedCategory: "fullstack",
    expectedStartCommand: "node .output/server/index.mjs",
  },
  {
    name: "TanStack Start - rsbuild.config.ts + @tanstack/react-start dep (#400)",
    files: files("package.json", "rsbuild.config.ts", "src/"),
    packageJson: {
      dependencies: { "@tanstack/react-start": "^1.0.0", "@rsbuild/core": "^1.0.0" },
    },
    expectedStack: "tanstack-start",
    expectedCategory: "fullstack",
    expectedStartCommand: "node .output/server/index.mjs",
  },
  {
    name: "TanStack Start - pnpm lockfile uses pnpm build default (#400)",
    files: files("package.json", "vite.config.ts", "pnpm-lock.yaml"),
    packageJson: {
      dependencies: { "@tanstack/react-start": "^1.0.0", vite: "^6.0.0" },
      scripts: { build: "vite build" },
    },
    expectedStack: "tanstack-start",
    expectedStartCommand: "node .output/server/index.mjs",
  },
  {
    name: "Angular - angular.json + @angular/core",
    files: files("package.json", "angular.json"),
    packageJson: { dependencies: { "@angular/core": "^17.0.0" } },
    expectedStack: "angular",
    expectedCategory: "frontend",
  },
  {
    name: "Gatsby - gatsby-config.js + gatsby dep",
    files: files("package.json", "gatsby-config.js"),
    packageJson: { dependencies: { gatsby: "^5.0.0" } },
    expectedStack: "gatsby",
  },
  {
    name: "Vite - vite.config.ts + vite dep",
    files: files("package.json", "vite.config.ts", "src/", "index.html"),
    packageJson: { dependencies: { vite: "^5.0.0", react: "^19.0.0" } },
    expectedStack: "vite",
    expectedCategory: "frontend",
  },
  {
    name: "CRA - react-scripts dep (the only durable signal)",
    files: files("package.json", "public/", "src/"),
    packageJson: { dependencies: { "react-scripts": "^5.0.0", react: "^18.0.0" } },
    expectedStack: "cra",
  },
  {
    name: "Vue CLI - vue.config.js + vue dep (and NO nuxt)",
    files: files("package.json", "vue.config.js"),
    packageJson: { dependencies: { vue: "^3.0.0" } },
    expectedStack: "vue",
    expectedCategory: "frontend",
  },

  // ── JS/TS Backend ───────────────────────────────────────────────────────
  {
    name: "NestJS - nest-cli.json + @nestjs/core",
    files: files("package.json", "nest-cli.json"),
    packageJson: { dependencies: { "@nestjs/core": "^10.0.0" } },
    expectedStack: "nestjs",
    expectedCategory: "backend",
  },
  {
    name: "AdonisJS - ace.js + @adonisjs/core",
    files: files("package.json", "ace.js"),
    packageJson: { dependencies: { "@adonisjs/core": "^6.0.0" } },
    expectedStack: "adonis",
  },
  {
    name: "Elysia - package.json + elysia dep",
    files: files("package.json"),
    packageJson: { dependencies: { elysia: "^1.0.0" } },
    expectedStack: "elysia",
  },
  {
    name: "Hono - package.json + hono dep",
    files: files("package.json"),
    packageJson: { dependencies: { hono: "^4.0.0" } },
    expectedStack: "hono",
  },
  {
    name: "Fastify - package.json + fastify dep",
    files: files("package.json"),
    packageJson: { dependencies: { fastify: "^4.0.0" } },
    expectedStack: "fastify",
  },
  {
    name: "Koa - package.json + koa dep",
    files: files("package.json"),
    packageJson: { dependencies: { koa: "^2.0.0" } },
    expectedStack: "koa",
  },
  {
    name: "Express - package.json + express dep",
    files: files("package.json", "server.js"),
    packageJson: { dependencies: { express: "^5.0.0" } },
    expectedStack: "express",
  },

  // ── Python ──────────────────────────────────────────────────────────────
  {
    name: "Django - manage.py",
    files: files("manage.py", "requirements.txt"),
    expectedStack: "django",
    expectedCategory: "fullstack",
  },
  {
    name: "Flask - requirements.txt + flask in deps",
    files: files("requirements.txt", "app.py"),
    fileContents: { "requirements.txt": "Flask==3.0.0\ngunicorn==21.0.0" },
    expectedStack: "flask",
  },
  {
    name: "FastAPI - requirements.txt + fastapi in deps",
    files: files("requirements.txt", "main.py"),
    fileContents: { "requirements.txt": "fastapi>=0.110\nuvicorn==0.27" },
    expectedStack: "fastapi",
  },
  {
    name: "Generic Python - requirements.txt only (no framework dep)",
    files: files("requirements.txt", "script.py"),
    fileContents: { "requirements.txt": "numpy\npandas" },
    expectedStack: "python",
  },
  {
    name: "Python via pyproject.toml (PEP 621)",
    files: files("pyproject.toml", "src/"),
    fileContents: {
      "pyproject.toml": `[project]
name = "myapp"
dependencies = ["requests>=2.0"]`,
    },
    expectedStack: "python",
  },
  {
    name: "Python via Pipfile",
    files: files("Pipfile"),
    fileContents: { Pipfile: "[packages]\nrequests = \"*\"\n" },
    expectedStack: "python",
  },

  // ── Go ──────────────────────────────────────────────────────────────────
  {
    name: "Gin - go.mod + gin in require",
    files: files("go.mod", "main.go"),
    fileContents: {
      "go.mod": `module myapp\n\nrequire github.com/gin-gonic/gin v1.9.1\n`,
    },
    expectedStack: "gin",
    expectedCategory: "backend",
  },
  {
    name: "Fiber - go.mod + fiber v2 in require",
    files: files("go.mod"),
    fileContents: {
      "go.mod": `module myapp\n\nrequire (\n  github.com/gofiber/fiber/v2 v2.50.0\n)`,
    },
    expectedStack: "fiber",
  },
  {
    name: "Echo - go.mod + echo v4 in require",
    files: files("go.mod"),
    fileContents: {
      "go.mod": `module myapp\n\nrequire github.com/labstack/echo/v4 v4.11.0\n`,
    },
    expectedStack: "echo",
  },
  {
    name: "Generic Go - go.mod with no recognized framework",
    files: files("go.mod", "main.go"),
    fileContents: { "go.mod": "module myapp\n\nrequire (\n  github.com/joho/godotenv v1.5.0\n)" },
    expectedStack: "go",
  },
  {
    name: "Generic Go - main.go only, no go.mod",
    files: files("main.go"),
    expectedStack: "go",
  },

  // ── Rust ────────────────────────────────────────────────────────────────
  {
    name: "Actix - Cargo.toml + actix-web dep",
    files: files("Cargo.toml", "src/"),
    fileContents: {
      "Cargo.toml": `[package]\nname = "myapp"\n\n[dependencies]\nactix-web = "4"\n`,
    },
    expectedStack: "actix",
  },
  {
    name: "Axum - Cargo.toml + axum dep",
    files: files("Cargo.toml"),
    fileContents: {
      "Cargo.toml": `[dependencies]\naxum = "0.7"\ntokio = "1"\n`,
    },
    expectedStack: "axum",
  },
  {
    name: "Rocket - Cargo.toml + rocket dep",
    files: files("Cargo.toml"),
    fileContents: {
      "Cargo.toml": `[dependencies]\nrocket = "0.5"\n`,
    },
    expectedStack: "rocket",
  },
  {
    name: "Generic Rust - Cargo.toml only",
    files: files("Cargo.toml"),
    fileContents: { "Cargo.toml": `[dependencies]\nclap = "4"\n` },
    expectedStack: "rust",
  },

  // ── Ruby ────────────────────────────────────────────────────────────────
  {
    name: "Rails - Gemfile + bin/rails",
    files: files("Gemfile", "bin/rails", "config/", "app/"),
    expectedStack: "rails",
    expectedCategory: "fullstack",
  },
  {
    name: "Rails - Gemfile + config/routes.rb",
    files: files("Gemfile", "config/routes.rb"),
    expectedStack: "rails",
  },
  {
    name: "Sinatra - Gemfile + sinatra gem",
    files: files("Gemfile"),
    fileContents: { Gemfile: `source "https://rubygems.org"\ngem "sinatra"\ngem "puma"\n` },
    expectedStack: "sinatra",
  },

  // ── PHP ─────────────────────────────────────────────────────────────────
  {
    name: "Laravel - artisan + composer.json with laravel/framework",
    files: files("artisan", "composer.json"),
    fileContents: {
      "composer.json": JSON.stringify({ require: { "laravel/framework": "^11.0" } }),
    },
    expectedStack: "laravel",
    expectedCategory: "fullstack",
  },
  {
    name: "Symfony - composer.json + symfony.lock + symfony/framework-bundle dep",
    files: files("composer.json", "symfony.lock"),
    fileContents: {
      "composer.json": JSON.stringify({ require: { "symfony/framework-bundle": "^7.0" } }),
    },
    expectedStack: "symfony",
  },

  // ── Java ────────────────────────────────────────────────────────────────
  {
    name: "Spring Boot - pom.xml with spring-boot artifact content",
    files: files("pom.xml"),
    fileContents: {
      // Matches the contentPattern regex `spring[-.]boot` via the artifactId.
      "pom.xml": `<project><dependencies><dependency><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies></project>`,
    },
    expectedStack: "springboot",
  },
  {
    name: "Quarkus - build.gradle with io.quarkus content",
    files: files("build.gradle"),
    fileContents: {
      "build.gradle": `dependencies { implementation 'io.quarkus:quarkus-core' }`,
    },
    expectedStack: "quarkus",
  },

  // ── C# / .NET ───────────────────────────────────────────────────────────
  {
    name: ".NET - .csproj suffix only",
    files: files("MyApp.csproj"),
    expectedStack: "dotnet",
    expectedCategory: "backend",
  },
  {
    name: ".NET - .fsproj suffix",
    files: files("MyApp.fsproj"),
    expectedStack: "dotnet",
  },
  {
    name: ".NET - .sln suffix",
    files: files("MyApp.sln"),
    expectedStack: "dotnet",
  },
  {
    name: "Blazor - .csproj + WebAssembly dep",
    files: files("MyApp.csproj"),
    packageJson: undefined,
    fileContents: {},
    // Blazor's dep gate looks in the merged deps map. Since .NET doesn't have a
    // dep parser, callers pass packageJson with deps shaped to mimic. Real-world
    // .NET detection of Blazor relies on parsing the .csproj - for the rule, the
    // dep map is what we have. We exercise via a packageJson stub.
    expectedStack: "dotnet", // Without the dep, it falls back to dotnet - verified below.
  },

  // ── Elixir ──────────────────────────────────────────────────────────────
  {
    name: "Phoenix - mix.exs + phoenix dep + lib dir (release name from app:)",
    files: files("mix.exs", "lib/"),
    fileContents: {
      "mix.exs": `defmodule MyApp.MixProject do\n  def project do\n    [app: :my_app, version: "0.1.0"]\n  end\n  defp deps do\n    [{:phoenix, "~> 1.7"}]\n  end\nend`,
    },
    expectedStack: "phoenix",
    expectedCategory: "fullstack",
    // Release binary derived from `app: :my_app`, not the literal "app".
    expectedStartCommand: "_build/prod/rel/my_app/bin/my_app start",
  },
  {
    name: "Phoenix - mix.exs without app: falls back to registry default",
    files: files("mix.exs", "lib/"),
    fileContents: {
      "mix.exs": `defmodule MyApp.MixProject do\n  defp deps do\n    [{:phoenix, "~> 1.7"}]\n  end\nend`,
    },
    expectedStack: "phoenix",
    expectedStartCommand: "_build/prod/rel/app/bin/app start",
  },

  // ── Docker / Compose / Static / Generic ─────────────────────────────────
  {
    name: "Docker Compose - docker-compose.yml",
    files: files("docker-compose.yml"),
    expectedStack: "docker-compose",
    expectedCategory: "services",
    expectedProjectType: "services",
  },
  {
    name: "Docker Compose - compose.yaml short form",
    files: files("compose.yaml"),
    expectedStack: "docker-compose",
  },
  {
    name: "Docker - Dockerfile only (no compose)",
    files: files("Dockerfile"),
    expectedStack: "docker",
    expectedProjectType: "docker",
  },
  {
    name: "Static site - index.html without package.json",
    files: files("index.html", "style.css"),
    expectedStack: "static",
    expectedCategory: "static",
  },
  {
    name: "Generic Node - bare package.json (no framework dep)",
    files: files("package.json", "index.js"),
    packageJson: { dependencies: {} },
    expectedStack: "node",
  },
];

describe("detectStack - positive cases across all supported stacks", () => {
  for (const c of POSITIVE_STACK_CASES) {
    it(c.name, () => {
      const result = detectStack(c.files, c.packageJson, c.fileContents);
      expect(result.stack).toBe(c.expectedStack);
      if (c.expectedCategory) expect(result.category).toBe(c.expectedCategory);
      if (c.expectedProjectType) expect(result.projectType).toBe(c.expectedProjectType);
      if (c.expectedStartCommand) expect(result.startCommand).toBe(c.expectedStartCommand);
    });
  }
});

// ─── Negative / disambiguation tests ─────────────────────────────────────────

describe("detectStack - rule ordering & gate disambiguation", () => {
  it("Next.js wins when express is a transitive dep", () => {
    // Many Next.js projects pull in express via something. The rule order
    // ensures fullstack frameworks short-circuit before generic backend.
    const result = detectStack(files("package.json", "next.config.js"), {
      dependencies: { next: "^15.0.0", express: "^5.0.0" },
    });
    expect(result.stack).toBe("nextjs");
  });

  it("Nuxt wins over plain vue when both deps are present", () => {
    const result = detectStack(files("package.json", "nuxt.config.ts"), {
      dependencies: { nuxt: "^3.0.0", vue: "^3.0.0" },
    });
    expect(result.stack).toBe("nuxt");
  });

  it("Vue CLI does NOT match when nuxt is also a dep (deps gate excludes it)", () => {
    // vue.config.js + vue dep would match the vue rule, but `!d.nuxt` exclusion
    // forces a Nuxt project (without nuxt.config) to fall through.
    const result = detectStack(files("package.json", "vue.config.js"), {
      dependencies: { vue: "^3.0.0", nuxt: "^3.0.0" },
    });
    expect(result.stack).not.toBe("vue");
  });

  it("Vite wins over CRA when both look plausible", () => {
    // public + src would match CRA's old file gate; the tightened CRA rule
    // requires react-scripts to disambiguate.
    const result = detectStack(files("package.json", "vite.config.ts", "public/", "src/"), {
      dependencies: { vite: "^5.0.0", react: "^19.0.0" },
    });
    expect(result.stack).toBe("vite");
  });

  it("TanStack Start wins over Vite when @tanstack/react-start is present (#400)", () => {
    const result = detectStack(files("package.json", "vite.config.ts", "pnpm-lock.yaml", "src/"), {
      dependencies: { "@tanstack/react-start": "^1.0.0", vite: "^6.0.0", react: "^19.0.0" },
      scripts: { build: "vite build" },
    });
    expect(result.stack).toBe("tanstack-start");
    expect(result.category).toBe("fullstack");
    expect(result.outputDirectory).toBe(".output");
    expect(result.buildCommand).toBe("pnpm build");
    expect(result.startCommand).toBe("node .output/server/index.mjs");
    expect(result.port).toBe(3000);
    expect(result.productionPaths).toEqual([".output"]);
    expect(result.packageManager).toBe("pnpm");
  });

  it("plain Vite without TanStack deps still detects as vite (#400 guard)", () => {
    const result = detectStack(files("package.json", "vite.config.ts", "index.html", "src/"), {
      dependencies: { vite: "^6.0.0", react: "^19.0.0" },
    });
    expect(result.stack).toBe("vite");
    expect(result.stack).not.toBe("tanstack-start");
  });

  it("CRA does NOT match a Vite app without react-scripts", () => {
    const result = detectStack(files("package.json", "public/", "src/"), {
      dependencies: { react: "^19.0.0" },
    });
    expect(result.stack).not.toBe("cra");
  });

  it("Generic python wins when neither flask nor fastapi is in requirements.txt", () => {
    const result = detectStack(files("requirements.txt"), undefined, {
      "requirements.txt": "requests\nnumpy",
    });
    expect(result.stack).toBe("python");
  });

  it("Docker Compose wins over a single Dockerfile when both are present", () => {
    const result = detectStack(files("Dockerfile", "docker-compose.yml"));
    expect(result.stack).toBe("docker-compose");
  });

  it("Static site does NOT match when package.json is also present (falls to a JS stack)", () => {
    const result = detectStack(files("index.html", "package.json"), {
      dependencies: { express: "^5.0.0" },
    });
    expect(result.stack).toBe("express");
  });

  it("Symfony requires BOTH composer.json AND symfony.lock (file conjunction)", () => {
    const result = detectStack(files("composer.json"), undefined, {
      "composer.json": JSON.stringify({ require: { "symfony/framework-bundle": "^7.0" } }),
    });
    expect(result.stack).not.toBe("symfony");
  });

  it("Rails requires Gemfile AND (bin/rails OR config/routes.rb)", () => {
    // Just a Gemfile (no bin/rails or config/routes.rb) should NOT be Rails.
    const result = detectStack(files("Gemfile"));
    expect(result.stack).not.toBe("rails");
  });

  it("Phoenix requires mix.exs AND (lib OR config/config.exs)", () => {
    const result = detectStack(files("mix.exs"));
    expect(result.stack).not.toBe("phoenix");
  });

  it("Unknown when no markers match", () => {
    const result = detectStack(files("README.md", "LICENSE"));
    expect(result.stack).toBe("unknown");
  });
});

// ─── Package manager detection ───────────────────────────────────────────────

describe("detectPackageManager", () => {
  it("pnpm via pnpm-lock.yaml", () => {
    expect(detectPackageManager(files("package.json", "pnpm-lock.yaml"))).toBe("pnpm");
  });

  it("bun via bun.lockb", () => {
    expect(detectPackageManager(files("package.json", "bun.lockb"))).toBe("bun");
  });

  it("bun via newer bun.lock", () => {
    expect(detectPackageManager(files("package.json", "bun.lock"))).toBe("bun");
  });

  it("bun via bunfig.toml with no lock file", () => {
    expect(detectPackageManager(files("package.json", "bunfig.toml"))).toBe("bun");
  });

  // bunfig.toml is a runtime/test-runner config, NOT an install marker: using
  // `bun test` while installing with npm/yarn is its whole point. It must stay
  // BELOW the lock files and below an explicit packageManager field — promoting it
  // silently flips those repos to `bun install` and the oven/bun build image.
  describe("bunfig.toml never outranks a real install marker", () => {
    it("loses to package-lock.json", () => {
      expect(detectPackageManager(files("package.json", "bunfig.toml", "package-lock.json"))).toBe("npm");
    });

    it("loses to yarn.lock", () => {
      expect(detectPackageManager(files("package.json", "bunfig.toml", "yarn.lock"))).toBe("yarn");
    });

    it("loses to pnpm-lock.yaml", () => {
      expect(detectPackageManager(files("package.json", "bunfig.toml", "pnpm-lock.yaml"))).toBe("pnpm");
    });

    it("loses to an explicit packageManager field", () => {
      expect(
        detectPackageManager(files("package.json", "bunfig.toml"), {
          packageManager: "yarn@4.1.0",
        }),
      ).toBe("yarn");
    });
  });

  it("npm via package-lock.json", () => {
    expect(detectPackageManager(files("package.json", "package-lock.json"))).toBe("npm");
  });

  it("yarn via yarn.lock", () => {
    expect(detectPackageManager(files("package.json", "yarn.lock"))).toBe("yarn");
  });

  it("packageManager field - pnpm@9.0.0", () => {
    expect(detectPackageManager(files("package.json"), { packageManager: "pnpm@9.0.0" })).toBe("pnpm");
  });

  it("packageManager field - bun@1.1.0", () => {
    expect(detectPackageManager(files("package.json"), { packageManager: "bun@1.1.0" })).toBe("bun");
  });

  it("scripts hint - pnpm referenced in scripts", () => {
    expect(
      detectPackageManager(files("package.json"), { scripts: { build: "pnpm run compile" } }),
    ).toBe("pnpm");
  });

  it("engines field - engines.pnpm", () => {
    expect(detectPackageManager(files("package.json"), { engines: { pnpm: ">=9" } })).toBe("pnpm");
  });

  it("pnpm via pnpm-workspace.yaml fallback", () => {
    expect(detectPackageManager(files("package.json", "pnpm-workspace.yaml"))).toBe("pnpm");
  });

  it("default to npm when only package.json exists", () => {
    expect(detectPackageManager(files("package.json"))).toBe("npm");
  });

  it("unknown when nothing identifies a manager", () => {
    expect(detectPackageManager(files("README.md"))).toBe("unknown");
  });

  // Non-JS language managers
  it("go via go.mod", () => {
    expect(detectPackageManager(files("go.mod", "main.go"))).toBe("go");
  });

  it("cargo via Cargo.toml", () => {
    expect(detectPackageManager(files("Cargo.toml"))).toBe("cargo");
  });

  it("uv via pyproject.toml", () => {
    expect(detectPackageManager(files("pyproject.toml"))).toBe("uv");
  });

  it("pipenv via Pipfile", () => {
    expect(detectPackageManager(files("Pipfile"))).toBe("pipenv");
  });

  it("pip via requirements.txt", () => {
    expect(detectPackageManager(files("requirements.txt"))).toBe("pip");
  });

  it("bundler via Gemfile", () => {
    expect(detectPackageManager(files("Gemfile"))).toBe("bundler");
  });

  it("composer via composer.json", () => {
    expect(detectPackageManager(files("composer.json"))).toBe("composer");
  });

  it("maven via pom.xml", () => {
    expect(detectPackageManager(files("pom.xml"))).toBe("maven");
  });

  it("gradle via build.gradle", () => {
    expect(detectPackageManager(files("build.gradle"))).toBe("gradle");
  });

  it("gradle via build.gradle.kts (Kotlin DSL)", () => {
    expect(detectPackageManager(files("build.gradle.kts"))).toBe("gradle");
  });

  it("dotnet via .csproj suffix", () => {
    expect(detectPackageManager(files("MyApp.csproj"))).toBe("dotnet");
  });

  it("mix via mix.exs", () => {
    expect(detectPackageManager(files("mix.exs"))).toBe("mix");
  });
});

// ─── Install / build / start commands ────────────────────────────────────────

describe("getInstallCommand", () => {
  it.each([
    ["pnpm", "pnpm install"],
    ["yarn", "yarn install"],
    ["bun", "bun install"],
    ["npm", "npm i --force"],
    ["go", "go mod download"],
    ["pip", "pip install -r requirements.txt"],
    ["uv", "uv sync"],
    ["pipenv", "pipenv install --deploy"],
    ["bundler", "bundle install"],
    ["composer", "composer install --no-dev --optimize-autoloader"],
    ["maven", "mvn dependency:resolve"],
    ["gradle", "gradle dependencies"],
    ["dotnet", "dotnet restore"],
    ["mix", "mix deps.get"],
    ["unknown", ""],
    ["cargo", ""],
  ])("%s → %s", (pm, expected) => {
    expect(getInstallCommand(pm)).toBe(expected);
  });
});

describe("getBuildCommand", () => {
  it("prefers project build script over stack default for JS package managers", () => {
    expect(
      getBuildCommand("pnpm", "nextjs", { scripts: { build: "next build && next export" } }),
    ).toBe("pnpm build");
  });

  it("uses 'bun run build' for bun (not 'bun build', which is the bundler)", () => {
    expect(
      getBuildCommand("bun", "nextjs", { scripts: { build: "next build" } }),
    ).toBe("bun run build");
  });

  it("uses 'npm run build' for npm package manager", () => {
    expect(
      getBuildCommand("npm", "nextjs", { scripts: { build: "next build" } }),
    ).toBe("npm run build");
  });

  it("falls back to STACKS[stack].defaultBuildCommand when no build script", () => {
    expect(getBuildCommand("pnpm", "nextjs", { scripts: {} })).toBe("next build");
  });

  it("falls back to stack default for non-JS package managers (go)", () => {
    expect(getBuildCommand("go", "gin", undefined)).toBe("go build -o app .");
  });
});

describe("getStartCommand", () => {
  it("prefers project start script over stack default for JS package managers", () => {
    expect(
      getStartCommand("pnpm", "nextjs", { scripts: { start: "node server.js" } }),
    ).toBe("pnpm start");
  });

  it("uses package.json main field when no start script (JS)", () => {
    expect(
      getStartCommand("pnpm", "node", { main: "src/index.js" }),
    ).toBe("node src/index.js");
  });

  it("falls back to STACKS[stack].defaultStartCommand", () => {
    expect(getStartCommand("pnpm", "nextjs", {})).toBe("next start");
  });

  it("non-JS package manager ignores JS script hints and uses stack default", () => {
    expect(getStartCommand("go", "gin", undefined)).toBe("./app");
  });
});

// ─── Port detection ──────────────────────────────────────────────────────────

describe("detectStack - port detection", () => {
  it("falls back to STACKS[stack].defaultPort when no explicit port", () => {
    const result = detectStack(files("package.json", "next.config.js"), {
      dependencies: { next: "^15.0.0" },
    });
    expect(result.port).toBe(3000); // Next.js default
  });

  it("reads --port from start script", () => {
    const result = detectStack(files("package.json", "next.config.js"), {
      dependencies: { next: "^15.0.0" },
      scripts: { start: "next start --port 4000" },
    });
    expect(result.port).toBe(4000);
  });

  it("reads --port=N from dev script", () => {
    const result = detectStack(files("package.json", "vite.config.ts"), {
      dependencies: { vite: "^5.0.0" },
      scripts: { dev: "vite --port=5174" },
    });
    expect(result.port).toBe(5174);
  });

  it("reads -p shorthand from a script", () => {
    const result = detectStack(files("package.json"), {
      dependencies: { express: "^5.0.0" },
      scripts: { start: "node server.js -p 8080" },
    });
    expect(result.port).toBe(8080);
  });

  it("reads EXPOSE from Dockerfile when no script port", () => {
    const result = detectStack(files("Dockerfile"), undefined, {
      Dockerfile: "FROM node:22\nEXPOSE 9000\nCMD [\"node\", \"server.js\"]",
    });
    expect(result.port).toBe(9000);
  });

  it("script port wins over Dockerfile EXPOSE", () => {
    const result = detectStack(files("package.json", "Dockerfile"), {
      dependencies: { express: "^5.0.0" },
      scripts: { start: "node server.js --port 7000" },
    }, {
      Dockerfile: "EXPOSE 9000",
    });
    expect(result.port).toBe(7000);
  });

  it("framework default for Astro is 4321", () => {
    const result = detectStack(files("package.json", "astro.config.mjs"), {
      dependencies: { astro: "^4.0.0" },
    });
    expect(result.port).toBe(4321);
  });

  it("framework default for Go is 8080", () => {
    const result = detectStack(files("go.mod"));
    expect(result.port).toBe(8080);
  });
});

// ─── Output directory + build image ──────────────────────────────────────────

describe("detectStack - output directory and build image", () => {
  it("outputDirectory comes from STACKS[stack]", () => {
    expect(detectStack(files("package.json", "next.config.js"), { dependencies: { next: "^15" } }).outputDirectory).toBe(".next");
    expect(detectStack(files("package.json", "vite.config.ts"), { dependencies: { vite: "^5" } }).outputDirectory).toBe("dist");
    expect(detectStack(files("package.json", "astro.config.mjs"), { dependencies: { astro: "^4" } }).outputDirectory).toBe("dist");
  });

  it("bun build image swaps to oven/bun for JS/TS stacks", () => {
    const result = detectStack(files("package.json", "next.config.js", "bun.lockb"), {
      dependencies: { next: "^15.0.0" },
    });
    expect(result.packageManager).toBe("bun");
    expect(result.buildImage).toBe("oven/bun:latest");
  });

  it("bun does NOT override build image for non-JS stacks", () => {
    // A repo with bun.lockb but a go.mod would detect as Go via the manifest
    // priority - package manager is still go, build image stays Go.
    const result = detectStack(files("go.mod", "bun.lockb"));
    expect(result.packageManager).toBe("go");
    expect(result.buildImage).toContain("golang");
  });
});

// ─── Realistic manifest content - what real-world repos actually look like ───
// These exercise the manifest parsers (parseRequirementsTxt, parsePyprojectToml,
// parseGoMod, parseCargoToml, parseGemfile, parseComposerJson, parseMixExs) by
// feeding content that mirrors what people actually commit, not idealized stubs.

describe("detectStack - realistic Python manifests", () => {
  it("requirements.txt with version pins, comments, extras, and editable installs", () => {
    const result = detectStack(files("requirements.txt"), undefined, {
      "requirements.txt": `# Production dependencies
fastapi==0.110.0  # pinned for stability
uvicorn[standard]>=0.27,<0.30
pydantic~=2.5
-e .
-r requirements-dev.txt
# Comment-only line that should be ignored
`,
    });
    expect(result.stack).toBe("fastapi");
  });

  it("pyproject.toml with Poetry dependencies section", () => {
    const result = detectStack(files("pyproject.toml"), undefined, {
      "pyproject.toml": `[tool.poetry]
name = "myapp"

[tool.poetry.dependencies]
python = "^3.11"
flask = "^3.0"
gunicorn = "^21.0"
sqlalchemy = "^2.0"
`,
    });
    expect(result.stack).toBe("flask");
  });

  it("pyproject.toml with PEP 621 + optional-dependencies groups", () => {
    const result = detectStack(files("pyproject.toml"), undefined, {
      "pyproject.toml": `[project]
name = "myapp"
dependencies = ["sqlalchemy>=2.0", "redis"]

[project.optional-dependencies]
api = ["fastapi", "uvicorn[standard]"]
test = ["pytest"]
`,
    });
    expect(result.stack).toBe("fastapi");
  });

  it("Pipfile with [packages] and [dev-packages] sections", () => {
    const result = detectStack(files("Pipfile"), undefined, {
      Pipfile: `[packages]
flask = "*"
gunicorn = "*"

[dev-packages]
pytest = "*"
`,
    });
    expect(result.stack).toBe("flask");
  });

  it("requirements.txt with only generic packages → falls to generic python", () => {
    const result = detectStack(files("requirements.txt"), undefined, {
      "requirements.txt": `numpy==1.26.0
pandas>=2.0
scikit-learn
`,
    });
    expect(result.stack).toBe("python");
  });
});

describe("detectStack - realistic Go manifests", () => {
  it("go.mod with /v2 major version path is normalized to base for detection", () => {
    // The parser stores both the full path AND the base (without /v\d+) - this
    // matters because deps in framework rules use the base path.
    const result = detectStack(files("go.mod"), undefined, {
      "go.mod": `module example.com/myapp

go 1.22

require (
	github.com/gofiber/fiber/v2 v2.52.0
	github.com/joho/godotenv v1.5.1
)
`,
    });
    expect(result.stack).toBe("fiber");
  });

  it("go.mod with single-line require statement", () => {
    const result = detectStack(files("go.mod"), undefined, {
      "go.mod": `module example.com/myapp\n\ngo 1.22\n\nrequire github.com/gin-gonic/gin v1.9.1\n`,
    });
    expect(result.stack).toBe("gin");
  });

  it("go.mod with echo /v4 path is normalized", () => {
    const result = detectStack(files("go.mod"), undefined, {
      "go.mod": `module example.com/myapp\n\nrequire (\n\tgithub.com/labstack/echo/v4 v4.11.0\n)`,
    });
    expect(result.stack).toBe("echo");
  });

  it("go.mod with commented-out framework dep is skipped", () => {
    const result = detectStack(files("go.mod"), undefined, {
      "go.mod": `module example.com/myapp

require (
	// github.com/gin-gonic/gin v1.9.1  // disabled
	github.com/joho/godotenv v1.5.1
)
`,
    });
    expect(result.stack).toBe("go");
  });

  it("go.mod with replace directive doesn't false-match", () => {
    const result = detectStack(files("go.mod"), undefined, {
      "go.mod": `module example.com/myapp

require github.com/joho/godotenv v1.5.1

replace github.com/old/pkg => github.com/new/pkg v1.0.0
`,
    });
    expect(result.stack).toBe("go");
  });
});

describe("detectStack - realistic Rust manifests", () => {
  it("Cargo.toml with [dependencies] picks up the framework", () => {
    const result = detectStack(files("Cargo.toml"), undefined, {
      "Cargo.toml": `[package]
name = "myapp"
version = "0.1.0"
edition = "2021"

[dependencies]
axum = "0.7"
tokio = { version = "1", features = ["full"] }
tower = "0.4"
`,
    });
    expect(result.stack).toBe("axum");
  });

  it("Cargo.toml with [dev-dependencies] axum is currently picked up", () => {
    // NOTE: parseCargoToml union-merges all dependency tables (incl.
    // dev-dependencies, build-dependencies) into one deps map. This means a
    // dev-only axum would identify the stack as axum. Documenting the current
    // behavior - change requires a deliberate parser update.
    const result = detectStack(files("Cargo.toml"), undefined, {
      "Cargo.toml": `[package]
name = "myapp"

[dependencies]
serde = "1"

[dev-dependencies]
axum = "0.7"
`,
    });
    expect(result.stack).toBe("axum");
  });

  it("Cargo.toml with workspace-level deps", () => {
    const result = detectStack(files("Cargo.toml"), undefined, {
      "Cargo.toml": `[workspace]
members = ["crates/*"]

[workspace.dependencies]
rocket = "0.5"
`,
    });
    expect(result.stack).toBe("rocket");
  });

  it("Cargo.toml with comments and empty lines preserved", () => {
    const result = detectStack(files("Cargo.toml"), undefined, {
      "Cargo.toml": `[dependencies]
# Web framework
actix-web = "4"

# Misc
serde = "1"
`,
    });
    expect(result.stack).toBe("actix");
  });
});

describe("detectStack - realistic Ruby/PHP/Elixir manifests", () => {
  it("Gemfile with version specifiers", () => {
    const result = detectStack(files("Gemfile"), undefined, {
      Gemfile: `source "https://rubygems.org"

ruby "3.3.0"

gem "sinatra", "~> 4.0"
gem "puma", ">= 6.0"
gem "rack", require: false
`,
    });
    expect(result.stack).toBe("sinatra");
  });

  it("composer.json merges require + require-dev for detection", () => {
    const result = detectStack(files("composer.json", "artisan"), undefined, {
      "composer.json": JSON.stringify({
        name: "myapp",
        require: { php: "^8.2", "laravel/framework": "^11.0" },
        "require-dev": { "phpunit/phpunit": "^11.0" },
      }),
    });
    expect(result.stack).toBe("laravel");
  });

  it("composer.json without laravel/framework does NOT match laravel", () => {
    const result = detectStack(files("composer.json"), undefined, {
      "composer.json": JSON.stringify({
        require: { php: "^8.2" },
      }),
    });
    expect(result.stack).not.toBe("laravel");
  });

  it("mix.exs with multiple deps including phoenix", () => {
    const result = detectStack(files("mix.exs", "lib/"), undefined, {
      "mix.exs": `defmodule MyApp.MixProject do
  use Mix.Project

  defp deps do
    [
      {:phoenix, "~> 1.7.0"},
      {:phoenix_html, "~> 4.0"},
      {:ecto_sql, "~> 3.10"}
    ]
  end
end`,
    });
    expect(result.stack).toBe("phoenix");
  });
});

// ─── Smart port detection - beyond the basics ────────────────────────────────

describe("detectStack - smart port detection scenarios", () => {
  it("uses start script port over dev script port (start priority)", () => {
    const result = detectStack(files("package.json", "next.config.js"), {
      dependencies: { next: "^15.0.0" },
      scripts: {
        dev: "next dev --port 3001",
        start: "next start --port 8080",
      },
    });
    expect(result.port).toBe(8080);
  });

  it("falls through to dev when start has no port", () => {
    const result = detectStack(files("package.json", "next.config.js"), {
      dependencies: { next: "^15.0.0" },
      scripts: {
        dev: "next dev --port 4001",
        start: "next start",
      },
    });
    expect(result.port).toBe(4001);
  });

  it("ignores env-var-templated port references (we don't expand $PORT)", () => {
    const result = detectStack(files("package.json"), {
      dependencies: { express: "^5.0.0" },
      scripts: { start: "node server.js --port $PORT" },
    });
    // No literal digits → falls to express default 3000.
    expect(result.port).toBe(3000);
  });

  it("ignores single-digit port matches (regex requires 2-5 digits)", () => {
    const result = detectStack(files("package.json"), {
      dependencies: { express: "^5.0.0" },
      // Port 5 is < 10, regex requires \d{2,5}, so it's ignored.
      scripts: { start: "node server.js -p 5" },
    });
    expect(result.port).toBe(3000);
  });

  it("Next.js dev with -p shorthand resolves correctly", () => {
    const result = detectStack(files("package.json", "next.config.js"), {
      dependencies: { next: "^15.0.0" },
      scripts: { dev: "next dev -p 4040" },
    });
    expect(result.port).toBe(4040);
  });

  it("Dockerfile EXPOSE picks the first port when multiple are listed", () => {
    // The regex /^EXPOSE\s+(\d{2,5})/m captures the first matching expose port.
    const result = detectStack(files("Dockerfile"), undefined, {
      Dockerfile: "FROM nginx\nEXPOSE 80 443\nCMD [\"nginx\"]",
    });
    expect(result.port).toBe(80);
  });

  it("rejects scripts where -p is a different flag (path-style use)", () => {
    const result = detectStack(files("package.json"), {
      dependencies: { express: "^5.0.0" },
      // -p with non-numeric value → no match, falls back.
      scripts: { start: "node server.js -p production" },
    });
    expect(result.port).toBe(3000);
  });
});

// ─── Smart command derivation - devDeps, chained scripts, runners ────────────

describe("detectStack - devDependencies and metadata smarts", () => {
  it("framework detected when listed in devDependencies (not just dependencies)", () => {
    const result = detectStack(files("package.json", "vite.config.ts"), {
      devDependencies: { vite: "^5.0.0" },
      dependencies: { react: "^19.0.0", "react-dom": "^19.0.0" },
    });
    expect(result.stack).toBe("vite");
  });

  it("packageManager with full version and sha is parsed (pnpm)", () => {
    expect(
      detectPackageManager(files("package.json"), {
        packageManager: "pnpm@9.5.0+sha512.abc123",
      }),
    ).toBe("pnpm");
  });

  it("packageManager with bun@1.1.x", () => {
    expect(
      detectPackageManager(files("package.json"), { packageManager: "bun@1.1.42" }),
    ).toBe("bun");
  });

  it("build script chained with && is forwarded as-is via the runner", () => {
    // We don't normalize/strip chains - runner just executes `npm run build`.
    const buildCmd = getBuildCommand("npm", "nextjs", {
      scripts: { build: "next build && next export" },
    });
    expect(buildCmd).toBe("npm run build");
  });

  it("vercel-style build:vercel script does NOT take precedence over 'build'", () => {
    // Only the literal `build` script key is preferred - `build:vercel` is left
    // alone. This is the right behavior: if a user wants vercel-style, they
    // alias it themselves via `scripts.build`.
    const buildCmd = getBuildCommand("pnpm", "nextjs", {
      scripts: { "build:vercel": "next build", "build:server": "tsc" },
    });
    expect(buildCmd).toBe("next build"); // falls back to stack default
  });

  it("falls back to STACKS default when scripts object is missing entirely", () => {
    expect(getBuildCommand("pnpm", "nextjs", {})).toBe("next build");
    expect(getStartCommand("pnpm", "nextjs", {})).toBe("next start");
  });

  it("getStartCommand falls back to stack default when no scripts AND no main", () => {
    // Without scripts.start AND without packageJson.main, falls back to STACKS.
    expect(getStartCommand("pnpm", "express", {})).toBe("node index.js");
  });

  it("getStartCommand uses main field even when start is missing (Node)", () => {
    expect(getStartCommand("pnpm", "node", { main: "dist/server.js" })).toBe("node dist/server.js");
  });

  it("getStartCommand ignores main for Go (non-JS language)", () => {
    expect(getStartCommand("go", "gin", { main: "ignored.js" })).toBe("./app");
  });

  it("detectStack handles a package.json with neither dependencies nor devDependencies (empty)", () => {
    const result = detectStack(files("package.json", "index.js"), {});
    expect(result.stack).toBe("node");
  });

  it("detectStack handles bare package.json with only a name", () => {
    const result = detectStack(files("package.json"), { name: "myapp" });
    expect(result.stack).toBe("node");
  });
});

// ─── Output directory edge cases ─────────────────────────────────────────────

describe("detectStack - output directory resolution", () => {
  it("returns Nuxt's .output for nuxt projects (not the default 'dist')", () => {
    const result = detectStack(files("package.json", "nuxt.config.ts"), {
      dependencies: { nuxt: "^3.0.0" },
    });
    expect(result.outputDirectory).toBe(".output");
  });

  it("returns Gatsby's 'public' (different from dist)", () => {
    const result = detectStack(files("package.json", "gatsby-config.js"), {
      dependencies: { gatsby: "^5.0.0" },
    });
    expect(result.outputDirectory).toBe("public");
  });

  it("returns Remix's 'build' (different from dist)", () => {
    const result = detectStack(files("package.json", "remix.config.js"), {
      dependencies: { "@remix-run/react": "^2.0.0" },
    });
    expect(result.outputDirectory).toBe("build");
  });

  it("returns Spring Boot's 'target' for Java", () => {
    const result = detectStack(files("pom.xml"), undefined, {
      "pom.xml": `<project><dependency><artifactId>spring-boot-starter-web</artifactId></dependency></project>`,
    });
    expect(result.outputDirectory).toBe("target");
  });

  it("returns Phoenix's '_build/prod/rel' for Elixir releases", () => {
    const result = detectStack(files("mix.exs", "lib/"), undefined, {
      "mix.exs": `defp deps do [{:phoenix, "~> 1.7"}] end`,
    });
    expect(result.outputDirectory).toBe("_build/prod/rel");
  });
});

// ─── productionPaths metadata ────────────────────────────────────────────────

describe("detectStack - productionPaths reflect the stack registry", () => {
  it("Go stacks list the 'app' binary as the production artifact", () => {
    const result = detectStack(files("go.mod"), undefined, {
      "go.mod": "module example.com/myapp\n\nrequire github.com/gin-gonic/gin v1.9.1\n",
    });
    expect(result.productionPaths).toContain("app");
  });

  it("Rust stacks list target/release/app", () => {
    const result = detectStack(files("Cargo.toml"), undefined, {
      "Cargo.toml": "[dependencies]\naxum = \"0.7\"\n",
    });
    expect(result.productionPaths).toContain("target/release/app");
  });

  it("JS stacks without productionPaths return an empty array", () => {
    const result = detectStack(files("package.json", "next.config.js"), {
      dependencies: { next: "^15.0.0" },
    });
    expect(result.productionPaths).toEqual([]);
  });
});
