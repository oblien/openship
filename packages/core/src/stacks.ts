/**
 * Stack registry — the single source of truth for every supported stack.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * To add a new framework / language:
 *   1. Add one entry here
 *   2. (Optional) Add detection rule in apps/api/src/lib/stack-detector.ts
 *   3. Done — types, schemas, constants all derive automatically
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Usage:
 *   import { STACKS, STACK_IDS, LANGUAGES, type StackId } from "@repo/core";
 *
 *   STACKS.nextjs.runtimeImage   // "node:22"
 *   STACKS.go.defaultPort        // 8080
 *   STACK_IDS                    // ["nextjs", "nuxt", ... ] — auto-generated
 */

// ─── Language definitions ────────────────────────────────────────────────────

export interface LanguageDefinition {
  name: string;
  /** Default build image — used when stack doesn't override */
  buildImage: string;
  /** Default runtime image */
  runtimeImage: string;
  /** Package managers available for this language */
  packageManagers: readonly string[];
}

export const LANGUAGES = {
  javascript: {
    name: "JavaScript",
    buildImage: "node:22",
    runtimeImage: "node:22",
    packageManagers: ["npm", "yarn", "pnpm", "bun"],
  },
  typescript: {
    name: "TypeScript",
    buildImage: "node:22",
    runtimeImage: "node:22",
    packageManagers: ["npm", "yarn", "pnpm", "bun"],
  },
  go: {
    name: "Go",
    buildImage: "golang:1.22-alpine",
    runtimeImage: "alpine:3.19",
    packageManagers: ["go"],
  },
  rust: {
    name: "Rust",
    buildImage: "rust:1.77-slim",
    runtimeImage: "debian:bookworm-slim",
    packageManagers: ["cargo"],
  },
  python: {
    name: "Python",
    buildImage: "python:3.12-slim",
    runtimeImage: "python:3.12-slim",
    packageManagers: ["pip", "poetry", "pipenv", "uv"],
  },
  ruby: {
    name: "Ruby",
    buildImage: "ruby:3.3-slim",
    runtimeImage: "ruby:3.3-slim",
    packageManagers: ["bundler"],
  },
  php: {
    name: "PHP",
    buildImage: "php:8.3-cli",
    runtimeImage: "php:8.3-fpm",
    packageManagers: ["composer"],
  },
  java: {
    name: "Java",
    buildImage: "eclipse-temurin:21-jdk-alpine",
    runtimeImage: "eclipse-temurin:21-jre-alpine",
    packageManagers: ["maven", "gradle"],
  },
  csharp: {
    name: "C#",
    buildImage: "mcr.microsoft.com/dotnet/sdk:8.0",
    runtimeImage: "mcr.microsoft.com/dotnet/aspnet:8.0",
    packageManagers: ["dotnet"],
  },
  elixir: {
    name: "Elixir",
    buildImage: "elixir:1.16-alpine",
    runtimeImage: "elixir:1.16-alpine",
    packageManagers: ["mix"],
  },
  multi: {
    name: "Multi-language",
    buildImage: "ubuntu:22.04",
    runtimeImage: "ubuntu:22.04",
    packageManagers: [],
  },
} as const satisfies Record<string, LanguageDefinition>;

export type Language = keyof typeof LANGUAGES;

// ─── Stack categories ────────────────────────────────────────────────────────

export type StackCategory = "frontend" | "backend" | "fullstack" | "static" | "docker" | "services" | "generic";

// ─── Project type (determines deploy-page UI path) ──────────────────────────

export type ProjectType = "app" | "docker" | "services";

// ─── Stack definition ────────────────────────────────────────────────────────

export interface StackDefinition {
  /** Human-readable display name */
  name: string;
  /** Programming language */
  language: Language;
  /** Category */
  category: StackCategory;
  /** Docker image for builds (overrides the language default) */
  buildImage?: string;
  /** Docker image for production runtime (overrides the language default) */
  runtimeImage?: string;
  /** Default output directory after build */
  outputDirectory: string;
  /** Default port the application listens on */
  defaultPort: number;
  /** Default build command when project has none */
  defaultBuildCommand: string;
  /** Default start command */
  defaultStartCommand: string;
}

// ─── The registry ────────────────────────────────────────────────────────────

export const STACKS = {

  // ── JavaScript / TypeScript — Frontend & Fullstack ─────────────────────────

  nextjs: {
    name: "Next.js",
    language: "typescript",
    category: "fullstack",
    outputDirectory: ".next",
    defaultPort: 3000,
    defaultBuildCommand: "next build",
    defaultStartCommand: "next start",
  },
  nuxt: {
    name: "Nuxt",
    language: "typescript",
    category: "fullstack",
    outputDirectory: ".output",
    defaultPort: 3000,
    defaultBuildCommand: "nuxt build",
    defaultStartCommand: "node .output/server/index.mjs",
  },
  sveltekit: {
    name: "SvelteKit",
    language: "typescript",
    category: "fullstack",
    outputDirectory: ".svelte-kit",
    defaultPort: 3000,
    defaultBuildCommand: "vite build",
    defaultStartCommand: "node build/index.js",
  },
  remix: {
    name: "Remix",
    language: "typescript",
    category: "fullstack",
    outputDirectory: "build",
    defaultPort: 3000,
    defaultBuildCommand: "remix build",
    defaultStartCommand: "remix-serve build/index.js",
  },
  astro: {
    name: "Astro",
    language: "typescript",
    category: "frontend",
    outputDirectory: "dist",
    defaultPort: 4321,
    defaultBuildCommand: "astro build",
    defaultStartCommand: "node dist/server/entry.mjs",
  },
  vite: {
    name: "Vite",
    language: "typescript",
    category: "frontend",
    outputDirectory: "dist",
    defaultPort: 5173,
    defaultBuildCommand: "vite build",
    defaultStartCommand: "",
  },
  angular: {
    name: "Angular",
    language: "typescript",
    category: "frontend",
    outputDirectory: "dist",
    defaultPort: 4200,
    defaultBuildCommand: "ng build --configuration production",
    defaultStartCommand: "",
  },
  gatsby: {
    name: "Gatsby",
    language: "javascript",
    category: "frontend",
    outputDirectory: "public",
    defaultPort: 8000,
    defaultBuildCommand: "gatsby build",
    defaultStartCommand: "gatsby serve",
  },
  cra: {
    name: "Create React App",
    language: "javascript",
    category: "frontend",
    outputDirectory: "build",
    defaultPort: 3000,
    defaultBuildCommand: "react-scripts build",
    defaultStartCommand: "",
  },
  vue: {
    name: "Vue CLI",
    language: "javascript",
    category: "frontend",
    outputDirectory: "dist",
    defaultPort: 8080,
    defaultBuildCommand: "vue-cli-service build",
    defaultStartCommand: "",
  },
  react: {
    name: "React",
    language: "javascript",
    category: "frontend",
    outputDirectory: "build",
    defaultPort: 3000,
    defaultBuildCommand: "",
    defaultStartCommand: "",
  },

  // ── JavaScript / TypeScript — Backend ──────────────────────────────────────

  express: {
    name: "Express",
    language: "javascript",
    category: "backend",
    outputDirectory: "dist",
    defaultPort: 3000,
    defaultBuildCommand: "",
    defaultStartCommand: "node index.js",
  },
  fastify: {
    name: "Fastify",
    language: "typescript",
    category: "backend",
    outputDirectory: "dist",
    defaultPort: 3000,
    defaultBuildCommand: "",
    defaultStartCommand: "node dist/index.js",
  },
  hono: {
    name: "Hono",
    language: "typescript",
    category: "backend",
    outputDirectory: "dist",
    defaultPort: 3000,
    defaultBuildCommand: "",
    defaultStartCommand: "node dist/index.js",
  },
  nestjs: {
    name: "NestJS",
    language: "typescript",
    category: "backend",
    outputDirectory: "dist",
    defaultPort: 3000,
    defaultBuildCommand: "nest build",
    defaultStartCommand: "node dist/main.js",
  },
  koa: {
    name: "Koa",
    language: "javascript",
    category: "backend",
    outputDirectory: "dist",
    defaultPort: 3000,
    defaultBuildCommand: "",
    defaultStartCommand: "node index.js",
  },
  adonis: {
    name: "AdonisJS",
    language: "typescript",
    category: "fullstack",
    outputDirectory: "build",
    defaultPort: 3333,
    defaultBuildCommand: "node ace build --production",
    defaultStartCommand: "node build/server.js",
  },
  elysia: {
    name: "Elysia",
    language: "typescript",
    category: "backend",
    outputDirectory: "dist",
    defaultPort: 3000,
    defaultBuildCommand: "",
    defaultStartCommand: "bun dist/index.js",
  },

  // ── Go ─────────────────────────────────────────────────────────────────────

  go: {
    name: "Go",
    language: "go",
    category: "backend",
    outputDirectory: ".",
    defaultPort: 8080,
    defaultBuildCommand: "go build -o app .",
    defaultStartCommand: "./app",
  },
  gin: {
    name: "Gin",
    language: "go",
    category: "backend",
    outputDirectory: ".",
    defaultPort: 8080,
    defaultBuildCommand: "go build -o app .",
    defaultStartCommand: "./app",
  },
  fiber: {
    name: "Fiber",
    language: "go",
    category: "backend",
    outputDirectory: ".",
    defaultPort: 3000,
    defaultBuildCommand: "go build -o app .",
    defaultStartCommand: "./app",
  },
  echo: {
    name: "Echo",
    language: "go",
    category: "backend",
    outputDirectory: ".",
    defaultPort: 8080,
    defaultBuildCommand: "go build -o app .",
    defaultStartCommand: "./app",
  },

  // ── Rust ───────────────────────────────────────────────────────────────────

  rust: {
    name: "Rust",
    language: "rust",
    category: "backend",
    outputDirectory: "target/release",
    defaultPort: 8080,
    defaultBuildCommand: "cargo build --release",
    defaultStartCommand: "./target/release/app",
  },
  actix: {
    name: "Actix Web",
    language: "rust",
    category: "backend",
    outputDirectory: "target/release",
    defaultPort: 8080,
    defaultBuildCommand: "cargo build --release",
    defaultStartCommand: "./target/release/app",
  },
  axum: {
    name: "Axum",
    language: "rust",
    category: "backend",
    outputDirectory: "target/release",
    defaultPort: 3000,
    defaultBuildCommand: "cargo build --release",
    defaultStartCommand: "./target/release/app",
  },
  rocket: {
    name: "Rocket",
    language: "rust",
    category: "backend",
    outputDirectory: "target/release",
    defaultPort: 8000,
    defaultBuildCommand: "cargo build --release",
    defaultStartCommand: "./target/release/app",
  },

  // ── Python ─────────────────────────────────────────────────────────────────

  python: {
    name: "Python",
    language: "python",
    category: "backend",
    outputDirectory: ".",
    defaultPort: 8000,
    defaultBuildCommand: "pip install -r requirements.txt",
    defaultStartCommand: "python app.py",
  },
  django: {
    name: "Django",
    language: "python",
    category: "fullstack",
    outputDirectory: ".",
    defaultPort: 8000,
    defaultBuildCommand: "pip install -r requirements.txt && python manage.py collectstatic --noinput",
    defaultStartCommand: "gunicorn config.wsgi:application --bind 0.0.0.0:8000",
  },
  flask: {
    name: "Flask",
    language: "python",
    category: "backend",
    outputDirectory: ".",
    defaultPort: 5000,
    defaultBuildCommand: "pip install -r requirements.txt",
    defaultStartCommand: "gunicorn app:app --bind 0.0.0.0:5000",
  },
  fastapi: {
    name: "FastAPI",
    language: "python",
    category: "backend",
    outputDirectory: ".",
    defaultPort: 8000,
    defaultBuildCommand: "pip install -r requirements.txt",
    defaultStartCommand: "uvicorn main:app --host 0.0.0.0 --port 8000",
  },

  // ── Ruby ───────────────────────────────────────────────────────────────────

  rails: {
    name: "Ruby on Rails",
    language: "ruby",
    category: "fullstack",
    outputDirectory: ".",
    defaultPort: 3000,
    defaultBuildCommand: "bundle install && bundle exec rails assets:precompile",
    defaultStartCommand: "bundle exec rails server -b 0.0.0.0",
  },
  sinatra: {
    name: "Sinatra",
    language: "ruby",
    category: "backend",
    outputDirectory: ".",
    defaultPort: 4567,
    defaultBuildCommand: "bundle install",
    defaultStartCommand: "ruby app.rb",
  },

  // ── PHP ────────────────────────────────────────────────────────────────────

  laravel: {
    name: "Laravel",
    language: "php",
    category: "fullstack",
    runtimeImage: "php:8.3-apache",
    outputDirectory: "public",
    defaultPort: 8000,
    defaultBuildCommand: "composer install --no-dev --optimize-autoloader",
    defaultStartCommand: "php artisan serve --host=0.0.0.0 --port=8000",
  },
  symfony: {
    name: "Symfony",
    language: "php",
    category: "fullstack",
    runtimeImage: "php:8.3-apache",
    outputDirectory: "public",
    defaultPort: 8000,
    defaultBuildCommand: "composer install --no-dev --optimize-autoloader",
    defaultStartCommand: "php -S 0.0.0.0:8000 -t public",
  },

  // ── Java / JVM ─────────────────────────────────────────────────────────────

  springboot: {
    name: "Spring Boot",
    language: "java",
    category: "backend",
    outputDirectory: "target",
    defaultPort: 8080,
    defaultBuildCommand: "mvn clean package -DskipTests",
    defaultStartCommand: "java -jar target/*.jar",
  },
  quarkus: {
    name: "Quarkus",
    language: "java",
    category: "backend",
    outputDirectory: "target",
    defaultPort: 8080,
    defaultBuildCommand: "mvn clean package -DskipTests",
    defaultStartCommand: "java -jar target/quarkus-app/quarkus-run.jar",
  },

  // ── C# / .NET ──────────────────────────────────────────────────────────────

  dotnet: {
    name: ".NET",
    language: "csharp",
    category: "backend",
    outputDirectory: "bin/Release/net8.0/publish",
    defaultPort: 5000,
    defaultBuildCommand: "dotnet publish -c Release -o publish",
    defaultStartCommand: "dotnet publish/app.dll",
  },
  blazor: {
    name: "Blazor",
    language: "csharp",
    category: "fullstack",
    outputDirectory: "bin/Release/net8.0/publish/wwwroot",
    defaultPort: 5000,
    defaultBuildCommand: "dotnet publish -c Release -o publish",
    defaultStartCommand: "dotnet publish/app.dll",
  },

  // ── Elixir ─────────────────────────────────────────────────────────────────

  phoenix: {
    name: "Phoenix",
    language: "elixir",
    category: "fullstack",
    outputDirectory: "_build/prod/rel",
    defaultPort: 4000,
    defaultBuildCommand: "MIX_ENV=prod mix do deps.get, compile, assets.deploy, release",
    defaultStartCommand: "_build/prod/rel/app/bin/app start",
  },

  // ── Generic ────────────────────────────────────────────────────────────────

  node: {
    name: "Node.js",
    language: "javascript",
    category: "backend",
    outputDirectory: "dist",
    defaultPort: 3000,
    defaultBuildCommand: "",
    defaultStartCommand: "node index.js",
  },
  static: {
    name: "Static Site",
    language: "multi",
    category: "static",
    runtimeImage: "nginx:alpine",
    outputDirectory: ".",
    defaultPort: 80,
    defaultBuildCommand: "",
    defaultStartCommand: "",
  },
  docker: {
    name: "Dockerfile",
    language: "multi",
    category: "docker",
    outputDirectory: ".",
    defaultPort: 3000,
    defaultBuildCommand: "",
    defaultStartCommand: "",
  },
  "docker-compose": {
    name: "Docker Compose",
    language: "multi",
    category: "services",
    outputDirectory: ".",
    defaultPort: 3000,
    defaultBuildCommand: "",
    defaultStartCommand: "",
  },
  unknown: {
    name: "Unknown",
    language: "multi",
    category: "generic",
    outputDirectory: "dist",
    defaultPort: 3000,
    defaultBuildCommand: "",
    defaultStartCommand: "",
  },
} as const satisfies Record<string, StackDefinition>;

// ─── Derived constants (auto-generated, never edit manually) ─────────────────

/** All stack IDs as a type — replaces the old hardcoded `Framework` union */
export type StackId = keyof typeof STACKS;

/** All stack IDs as a runtime array */
export const STACK_IDS = Object.keys(STACKS) as StackId[];

/** All language IDs as a runtime array */
export const LANGUAGE_IDS = Object.keys(LANGUAGES) as Language[];

/** All unique package managers across all languages */
export const ALL_PACKAGE_MANAGERS: string[] = [
  ...new Set(Object.values(LANGUAGES).flatMap((l) => l.packageManagers)),
];

/** Output directories keyed by stack — derived from STACKS */
export const OUTPUT_DIRECTORIES: Record<string, string> = Object.fromEntries(
  Object.entries(STACKS).map(([id, s]) => [id, s.outputDirectory]),
);

/** JS/TS languages that should use oven/bun when the package manager is bun */
const BUN_ELIGIBLE_LANGUAGES: ReadonlySet<string> = new Set(["javascript", "typescript"]);

/** Get the resolved Docker build image for a stack */
export function getBuildImage(stackId: StackId, packageManager?: string): string {
  const stack = STACKS[stackId] as StackDefinition;
  if (packageManager === "bun" && BUN_ELIGIBLE_LANGUAGES.has(stack.language)) {
    return "oven/bun:latest";
  }
  return stack.buildImage ?? LANGUAGES[stack.language].buildImage;
}

/** Get the resolved Docker runtime image for a stack */
export function getRuntimeImage(stackId: StackId, packageManager?: string): string {
  const stack = STACKS[stackId] as StackDefinition;
  if (packageManager === "bun" && BUN_ELIGIBLE_LANGUAGES.has(stack.language)) {
    return "oven/bun:latest";
  }
  return stack.runtimeImage ?? LANGUAGES[stack.language].runtimeImage;
}


/** Get the full stack definition with resolved images */
export function getStackDefaults(stackId: StackId, packageManager?: string) {
  const stack = STACKS[stackId] as StackDefinition;
  return {
    ...stack,
    buildImage: getBuildImage(stackId, packageManager),
    runtimeImage: getRuntimeImage(stackId, packageManager),
  };
}

/** Derive the project type from a stack ID */
export function getProjectType(stackId: StackId): ProjectType {
  const cat = (STACKS[stackId] as StackDefinition).category;
  if (cat === "docker") return "docker";
  if (cat === "services") return "services";
  return "app";
}

/**
 * Hint whether a stack is typically static (no running server).
 * Used as a default for the hasServer toggle — the user can override.
 */
export function isTypicallyStatic(stackId: StackId): boolean {
  const stack = STACKS[stackId] as StackDefinition;
  return (
    (stack.category === "static" || stack.category === "frontend") &&
    !stack.defaultStartCommand
  );
}

// ─── Icon URLs — source of truth for logo/icon display ───────────────────────

const DI = "https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons";

export const STACK_ICONS: Partial<Record<StackId, string>> = {
  // JS/TS — Frontend & Fullstack
  nextjs:      `${DI}/nextjs/nextjs-original.svg`,
  nuxt:        `${DI}/nuxtjs/nuxtjs-original.svg`,
  sveltekit:   `${DI}/svelte/svelte-original.svg`,
  remix:       `${DI}/react/react-original.svg`,
  astro:       `${DI}/astro/astro-original.svg`,
  vite:        `${DI}/vitejs/vitejs-original.svg`,
  angular:     `${DI}/angular/angular-original.svg`,
  gatsby:      `${DI}/gatsby/gatsby-original.svg`,
  cra:         `${DI}/react/react-original.svg`,
  vue:         `${DI}/vuejs/vuejs-original.svg`,
  react:       `${DI}/react/react-original.svg`,

  // JS/TS — Backend
  express:     `${DI}/express/express-original.svg`,
  fastify:     `${DI}/fastify/fastify-original.svg`,
  hono:        "https://hono.dev/images/logo-small.png",
  nestjs:      `${DI}/nestjs/nestjs-original.svg`,
  koa:         `${DI}/nodejs/nodejs-original.svg`,
  adonis:      `${DI}/adonisjs/adonisjs-original.svg`,
  elysia:      "https://elysiajs.com/assets/elysia.svg",

  // Go
  go:          `${DI}/go/go-original.svg`,
  gin:         `${DI}/go/go-original.svg`,
  fiber:       `${DI}/go/go-original.svg`,
  echo:        `${DI}/go/go-original.svg`,

  // Rust
  rust:        `${DI}/rust/rust-original.svg`,
  actix:       `${DI}/rust/rust-original.svg`,
  axum:        `${DI}/rust/rust-original.svg`,
  rocket:      `${DI}/rust/rust-original.svg`,

  // Python
  python:      `${DI}/python/python-original.svg`,
  django:      `${DI}/django/django-plain.svg`,
  flask:       `${DI}/flask/flask-original.svg`,
  fastapi:     `${DI}/fastapi/fastapi-original.svg`,

  // Ruby
  rails:       `${DI}/rails/rails-plain.svg`,
  sinatra:     `${DI}/ruby/ruby-original.svg`,

  // PHP
  laravel:     `${DI}/laravel/laravel-original.svg`,
  symfony:     `${DI}/symfony/symfony-original.svg`,

  // Java
  springboot:  `${DI}/spring/spring-original.svg`,
  quarkus:     `${DI}/quarkus/quarkus-original.svg`,

  // C# / .NET
  dotnet:      `${DI}/dotnetcore/dotnetcore-original.svg`,
  blazor:      `${DI}/dotnetcore/dotnetcore-original.svg`,

  // Elixir
  phoenix:     `${DI}/phoenix/phoenix-original.svg`,

  // Generic
  node:        `${DI}/nodejs/nodejs-original.svg`,
  static:      `${DI}/html5/html5-original.svg`,
  docker:      `${DI}/docker/docker-original.svg`,
  "docker-compose": `${DI}/docker/docker-original.svg`,
};
