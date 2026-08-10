/**
 * Stack registry - the single source of truth for every supported stack.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * To add a new framework / language:
 *   1. Add one entry here
 *   2. (Optional) Add detection rule in apps/api/src/lib/stack-detector.ts
 *   3. Done - types, schemas, constants all derive automatically
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Usage:
 *   import { STACKS, STACK_IDS, LANGUAGES, type StackId } from "@repo/core";
 *
 *   STACKS.nextjs.runtimeImage   // "node:22"
 *   STACKS.go.defaultPort        // 8080
 *   STACK_IDS                    // ["nextjs", "nuxt", ... ] - auto-generated
 */

// ─── Language definitions ────────────────────────────────────────────────────

export interface LanguageDefinition {
  name: string;
  /** Default build image - used when stack doesn't override */
  buildImage: string;
  /** Default runtime image */
  runtimeImage: string;
  /** Package managers available for this language */
  packageManagers: readonly string[];
  /**
   * Tools required on bare metal to build/run this language.
   * Used by the toolchain catalog to validate and install prerequisites.
   * Empty array means no tool validation needed (e.g. multi-language, docker).
   */
  requiredTools: readonly string[];
}

export const LANGUAGES = {
  javascript: {
    name: "JavaScript",
    buildImage: "node:22",
    runtimeImage: "node:22",
    packageManagers: ["npm", "yarn", "pnpm", "bun"],
    requiredTools: ["node", "npm"],
  },
  typescript: {
    name: "TypeScript",
    buildImage: "node:22",
    runtimeImage: "node:22",
    packageManagers: ["npm", "yarn", "pnpm", "bun"],
    requiredTools: ["node", "npm"],
  },
  go: {
    name: "Go",
    buildImage: "golang:1.22-alpine",
    runtimeImage: "alpine:3.19",
    packageManagers: ["go"],
    requiredTools: ["go"],
  },
  rust: {
    name: "Rust",
    buildImage: "rust:1.77-slim",
    runtimeImage: "debian:bookworm-slim",
    packageManagers: ["cargo"],
    requiredTools: ["rustc", "cargo"],
  },
  python: {
    name: "Python",
    buildImage: "python:3.12-slim",
    runtimeImage: "python:3.12-slim",
    packageManagers: ["pip", "poetry", "pipenv", "uv"],
    requiredTools: ["python3", "pip"],
  },
  ruby: {
    name: "Ruby",
    buildImage: "ruby:3.3-slim",
    runtimeImage: "ruby:3.3-slim",
    packageManagers: ["bundler"],
    requiredTools: ["ruby", "bundler"],
  },
  php: {
    name: "PHP",
    buildImage: "php:8.4-cli",
    // FrankenPHP, not php:*-fpm. An fpm image is a FastCGI backend, not a
    // process host: it ships no web server, and pairing it with an apt nginx
    // means two processes under a shell that swallows SIGTERM — a container stop
    // then kills in-flight work instead of draining it. FrankenPHP is ONE
    // process that owns both the HTTP server and PHP, so signals land where they
    // should with no supervision tree, it runs fine as a non-root user, and its
    // docroot convention (`/app/public`) is already the layout our recipes emit.
    runtimeImage: "dunglas/frankenphp:1-php8.4-bookworm",
    packageManagers: ["composer"],
    requiredTools: ["php", "composer"],
  },
  java: {
    name: "Java",
    // Maven image bundles both `mvn` and JDK 21, so the generated Dockerfile
    // builds Maven projects out of the box; Gradle/Kotlin projects build via
    // their `./gradlew` wrapper (needs only the JDK, which this image has).
    buildImage: "maven:3.9-eclipse-temurin-21",
    runtimeImage: "eclipse-temurin:21-jre-alpine",
    packageManagers: ["maven", "gradle"],
    requiredTools: ["java", "javac"],
  },
  csharp: {
    name: "C#",
    buildImage: "mcr.microsoft.com/dotnet/sdk:8.0",
    runtimeImage: "mcr.microsoft.com/dotnet/aspnet:8.0",
    packageManagers: ["dotnet"],
    requiredTools: ["dotnet"],
  },
  elixir: {
    name: "Elixir",
    buildImage: "elixir:1.16-alpine",
    runtimeImage: "elixir:1.16-alpine",
    packageManagers: ["mix"],
    requiredTools: ["elixir", "mix"],
  },
  multi: {
    name: "Multi-language",
    buildImage: "ubuntu:22.04",
    runtimeImage: "ubuntu:22.04",
    packageManagers: [],
    requiredTools: [],
  },
} as const satisfies Record<string, LanguageDefinition>;

export type Language = keyof typeof LANGUAGES;

// ─── Stack categories ────────────────────────────────────────────────────────

export type StackCategory = "frontend" | "backend" | "fullstack" | "static" | "docker" | "services" | "generic";

// ─── Project type (determines deploy-page UI path) ──────────────────────────

export type ProjectType = "app" | "docker" | "services" | "monorepo";

// ─── Stack definition ────────────────────────────────────────────────────────

/**
 * Detection inputs for a stack. Used by both `detectStack` (which framework is this?)
 * and `project-root-detector` (where in the tree is a deployable project?).
 *
 * Keep this declarative - every stack adds exactly one entry here, and both the
 * framework-rule list and the root-marker set derive from it. If you find yourself
 * adding fileMatch/depMatch overrides in `stack-detector.ts`, that's a sign the
 * stack has irregular detection (e.g. negations or conjunctions) - fine, but
 * `rootMarkers` here must still list the project-root signals.
 */
export interface StackDetection {
  /**
   * Files whose presence at a directory marks that directory as a candidate
   * project root for this stack. Lowercased basenames; nested-path markers
   * (e.g. "config/routes.rb") are also accepted and matched verbatim.
   */
  rootMarkers?: readonly string[];
  /**
   * Dependency names (from package.json / requirements.txt / go.mod / Cargo.toml /
   * Gemfile / composer.json / mix.exs) whose presence implies this stack.
   */
  deps?: readonly string[];
  /**
   * Filename → regex source pairs. If the file content matches, the stack is
   * implied. Used when a stack can't be discriminated by deps alone
   * (e.g. Spring Boot in build.gradle).
   */
  contentPatterns?: Readonly<Record<string, string>>;
}

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
  /** Minimum tool versions required by this stack on bare metal. */
  requiredToolVersions?: Readonly<Record<string, string>>;
  /**
   * Override the tool list inherited from the language. Use for stacks that
   * intentionally bypass the language default - e.g. a TypeScript stack that
   * runs on bun instead of node. When omitted, the language's `requiredTools`
   * is used.
   */
  requiredTools?: readonly string[];
  /**
   * Files/directories to copy into `/app/production/` after build.
   * Only these paths are needed at runtime - everything else stays in `/app`.
   * Omit for stacks where everything is needed (e.g. docker, static).
   */
  productionPaths?: readonly string[];
  /**
   * Directories created during build that can be excluded from transfer.
   * Only framework-specific caches - generic ones (.git) are always excluded.
   */
  cacheDirs?: readonly string[];
  /**
   * Paths (relative to the app root) this framework WRITES at runtime and would
   * lose on redeploy. Declared here so a stock app keeps its data with no
   * configuration; the project can override the list. Resolved by
   * `resolveStackVolumes` in `volumes.ts`, which turns each entry into a real
   * mount — so keep them to paths that are genuinely stateful. A path that also
   * holds CODE must not be listed: mounting over it shadows what later releases
   * ship there (Laravel's `database/` holds migrations as well as the SQLite
   * file, which is why only `storage` is declared).
   */
  persistentPaths?: readonly string[];
  /**
   * Preferred build location for this stack.
   * "server" = build in the cloud/workspace (default if omitted).
   * "local"  = build on the host machine, then transfer the artifact.
   */
  defaultBuildStrategy?: "server" | "local";
  /**
   * Detection signals - files / deps / content patterns. Consumed by
   * `stack-detector.ts` and `project-root-detector.ts`. See {@link StackDetection}.
   */
  detection?: StackDetection;
}

// ─── The registry ────────────────────────────────────────────────────────────

export const STACKS = {

  // ── JavaScript / TypeScript - Frontend & Fullstack ─────────────────────────

  nextjs: {
    name: "Next.js",
    language: "typescript",
    category: "fullstack",
    outputDirectory: ".next",
    defaultPort: 3000,
    defaultBuildCommand: "next build",
    defaultStartCommand: "next start",
    requiredToolVersions: { node: "20.9.0" },
    cacheDirs: [".next/cache"],    detection: {
      rootMarkers: ["next.config.js", "next.config.mjs", "next.config.ts"],
      deps: ["next"],
    },
  },
  nuxt: {
    name: "Nuxt",
    language: "typescript",
    category: "fullstack",
    outputDirectory: ".output",
    defaultPort: 3000,
    defaultBuildCommand: "nuxt build",
    defaultStartCommand: "node .output/server/index.mjs",
    cacheDirs: [".nuxt"],    detection: {
      rootMarkers: ["nuxt.config.js", "nuxt.config.ts", "nuxt.config.mjs"],
      deps: ["nuxt", "@nuxt/core"],
    },
  },
  sveltekit: {
    name: "SvelteKit",
    language: "typescript",
    category: "fullstack",
    outputDirectory: ".svelte-kit",
    defaultPort: 3000,
    defaultBuildCommand: "vite build",
    defaultStartCommand: "node build/index.js",    detection: {
      rootMarkers: ["svelte.config.js", "svelte.config.mjs"],
      deps: ["svelte", "@sveltejs/kit"],
    },
  },
  remix: {
    name: "Remix",
    language: "typescript",
    category: "fullstack",
    outputDirectory: "build",
    defaultPort: 3000,
    defaultBuildCommand: "remix build",
    defaultStartCommand: "remix-serve build/index.js",    detection: {
      rootMarkers: ["remix.config.js", "remix.config.ts"],
      deps: ["@remix-run/react", "@remix-run/node", "remix"],
    },
  },
  "tanstack-start": {
    name: "TanStack Start",
    language: "typescript",
    category: "fullstack",
    outputDirectory: ".output",
    defaultPort: 3000,
    defaultBuildCommand: "vite build",
    defaultStartCommand: "node .output/server/index.mjs",
    // Nitro/Vinxi server bundle is self-contained under .output — same shape as Nuxt.
    productionPaths: [".output"],
    detection: {
      // TanStack Start is Vite/Rsbuild-based; app.config.* is the older
      // framework-specific marker, while current apps commonly ship vite.config.*
      // or rsbuild.config.* plus the start package dep.
      rootMarkers: [
        "app.config.ts",
        "app.config.js",
        "app.config.mjs",
        "vite.config.ts",
        "vite.config.js",
        "vite.config.mjs",
        "rsbuild.config.ts",
        "rsbuild.config.js",
        "rsbuild.config.mjs",
      ],
      deps: ["@tanstack/react-start", "@tanstack/start"],
    },
  },
  astro: {
    name: "Astro",
    language: "typescript",
    category: "frontend",
    outputDirectory: "dist",
    defaultPort: 4321,
    defaultBuildCommand: "astro build",
    defaultStartCommand: "node dist/server/entry.mjs",    detection: {
      rootMarkers: ["astro.config.mjs", "astro.config.js", "astro.config.ts"],
      deps: ["astro"],
    },
  },
  vite: {
    name: "Vite",
    language: "typescript",
    category: "frontend",
    outputDirectory: "dist",
    defaultPort: 5173,
    defaultBuildCommand: "vite build",
    defaultStartCommand: "",    detection: {
      rootMarkers: ["vite.config.js", "vite.config.ts", "vite.config.mjs"],
      deps: ["vite"],
    },
  },
  angular: {
    name: "Angular",
    language: "typescript",
    category: "frontend",
    outputDirectory: "dist",
    defaultPort: 4200,
    defaultBuildCommand: "ng build --configuration production",
    defaultStartCommand: "",    detection: {
      rootMarkers: ["angular.json"],
      deps: ["@angular/core"],
    },
  },
  gatsby: {
    name: "Gatsby",
    language: "javascript",
    category: "frontend",
    outputDirectory: "public",
    defaultPort: 8000,
    defaultBuildCommand: "gatsby build",
    defaultStartCommand: "gatsby serve",
    cacheDirs: [".cache"],    detection: {
      rootMarkers: ["gatsby-config.js", "gatsby-config.ts"],
      deps: ["gatsby"],
    },
  },
  cra: {
    name: "Create React App",
    language: "javascript",
    category: "frontend",
    outputDirectory: "build",
    defaultPort: 3000,
    defaultBuildCommand: "react-scripts build",
    defaultStartCommand: "",    detection: {
      // CRA's only durable signal is the react-scripts dep; the public+src
      // layout is shared with many other React setups.
      deps: ["react-scripts"],
    },
  },
  vue: {
    name: "Vue CLI",
    language: "javascript",
    category: "frontend",
    outputDirectory: "dist",
    defaultPort: 8080,
    defaultBuildCommand: "vue-cli-service build",
    defaultStartCommand: "",    detection: {
      rootMarkers: ["vue.config.js", "vue.config.ts"],
      // Note: deps gate is the disambiguator vs. Nuxt - checked in stack-detector.
      deps: ["vue"],
    },
  },
  react: {
    name: "React",
    language: "javascript",
    category: "frontend",
    outputDirectory: "build",
    defaultPort: 3000,
    defaultBuildCommand: "",
    defaultStartCommand: "",  },

  // ── JavaScript / TypeScript - Backend ──────────────────────────────────────

  express: {
    name: "Express",
    language: "javascript",
    category: "backend",
    outputDirectory: "dist",
    defaultPort: 3000,
    defaultBuildCommand: "",
    defaultStartCommand: "node index.js",    detection: {
      deps: ["express"],
    },
  },
  fastify: {
    name: "Fastify",
    language: "typescript",
    category: "backend",
    outputDirectory: "dist",
    defaultPort: 3000,
    defaultBuildCommand: "",
    defaultStartCommand: "node dist/index.js",    detection: {
      deps: ["fastify"],
    },
  },
  hono: {
    name: "Hono",
    language: "typescript",
    category: "backend",
    outputDirectory: "dist",
    defaultPort: 3000,
    defaultBuildCommand: "",
    defaultStartCommand: "node dist/index.js",    detection: {
      deps: ["hono"],
    },
  },
  nestjs: {
    name: "NestJS",
    language: "typescript",
    category: "backend",
    outputDirectory: "dist",
    defaultPort: 3000,
    defaultBuildCommand: "nest build",
    defaultStartCommand: "node dist/main.js",    detection: {
      rootMarkers: ["nest-cli.json"],
      deps: ["@nestjs/core"],
    },
  },
  koa: {
    name: "Koa",
    language: "javascript",
    category: "backend",
    outputDirectory: "dist",
    defaultPort: 3000,
    defaultBuildCommand: "",
    defaultStartCommand: "node index.js",    detection: {
      deps: ["koa"],
    },
  },
  adonis: {
    name: "AdonisJS",
    language: "typescript",
    category: "fullstack",
    outputDirectory: "build",
    defaultPort: 3333,
    defaultBuildCommand: "node ace build --production",
    defaultStartCommand: "node build/server.js",    detection: {
      rootMarkers: ["ace.js", ".adonisrc.json", "adonisrc.ts"],
      deps: ["@adonisjs/core"],
    },
  },
  elysia: {
    name: "Elysia",
    language: "typescript",
    category: "backend",
    outputDirectory: "dist",
    defaultPort: 3000,
    defaultBuildCommand: "",
    defaultStartCommand: "bun dist/index.js",    detection: {
      deps: ["elysia"],
    },
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
    productionPaths: ["app"],
    detection: {
      rootMarkers: ["go.mod"],
    },
  },
  gin: {
    name: "Gin",
    language: "go",
    category: "backend",
    outputDirectory: ".",
    defaultPort: 8080,
    defaultBuildCommand: "go build -o app .",
    defaultStartCommand: "./app",
    productionPaths: ["app"],
    detection: {
      rootMarkers: ["go.mod"],
      deps: ["github.com/gin-gonic/gin"],
    },
  },
  fiber: {
    name: "Fiber",
    language: "go",
    category: "backend",
    outputDirectory: ".",
    defaultPort: 3000,
    defaultBuildCommand: "go build -o app .",
    defaultStartCommand: "./app",
    productionPaths: ["app"],
    detection: {
      rootMarkers: ["go.mod"],
      deps: ["github.com/gofiber/fiber"],
    },
  },
  echo: {
    name: "Echo",
    language: "go",
    category: "backend",
    outputDirectory: ".",
    defaultPort: 8080,
    defaultBuildCommand: "go build -o app .",
    defaultStartCommand: "./app",
    productionPaths: ["app"],
    detection: {
      rootMarkers: ["go.mod"],
      deps: ["github.com/labstack/echo"],
    },
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
    productionPaths: ["target/release/app"],
    detection: {
      rootMarkers: ["Cargo.toml"],
    },
  },
  actix: {
    name: "Actix Web",
    language: "rust",
    category: "backend",
    outputDirectory: "target/release",
    defaultPort: 8080,
    defaultBuildCommand: "cargo build --release",
    defaultStartCommand: "./target/release/app",
    productionPaths: ["target/release/app"],
    detection: {
      rootMarkers: ["Cargo.toml"],
      deps: ["actix-web"],
    },
  },
  axum: {
    name: "Axum",
    language: "rust",
    category: "backend",
    outputDirectory: "target/release",
    defaultPort: 3000,
    defaultBuildCommand: "cargo build --release",
    defaultStartCommand: "./target/release/app",
    productionPaths: ["target/release/app"],
    detection: {
      rootMarkers: ["Cargo.toml"],
      deps: ["axum"],
    },
  },
  rocket: {
    name: "Rocket",
    language: "rust",
    category: "backend",
    outputDirectory: "target/release",
    defaultPort: 8000,
    defaultBuildCommand: "cargo build --release",
    defaultStartCommand: "./target/release/app",
    productionPaths: ["target/release/app"],
    detection: {
      rootMarkers: ["Cargo.toml"],
      deps: ["rocket"],
    },
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
    detection: {
      rootMarkers: ["requirements.txt", "pyproject.toml", "Pipfile", "setup.py"],
    },
  },
  django: {
    name: "Django",
    language: "python",
    category: "fullstack",
    outputDirectory: ".",
    defaultPort: 8000,
    defaultBuildCommand: "pip install -r requirements.txt && python manage.py collectstatic --noinput",
    defaultStartCommand: "gunicorn config.wsgi:application --bind 0.0.0.0:8000",
    detection: {
      rootMarkers: ["manage.py"],
    },
  },
  flask: {
    name: "Flask",
    language: "python",
    category: "backend",
    outputDirectory: ".",
    defaultPort: 5000,
    defaultBuildCommand: "pip install -r requirements.txt",
    defaultStartCommand: "gunicorn app:app --bind 0.0.0.0:5000",
    detection: {
      rootMarkers: ["requirements.txt", "pyproject.toml", "Pipfile"],
      deps: ["flask", "Flask"],
    },
  },
  fastapi: {
    name: "FastAPI",
    language: "python",
    category: "backend",
    outputDirectory: ".",
    defaultPort: 8000,
    defaultBuildCommand: "pip install -r requirements.txt",
    defaultStartCommand: "uvicorn main:app --host 0.0.0.0 --port 8000",
    detection: {
      rootMarkers: ["requirements.txt", "pyproject.toml", "Pipfile"],
      deps: ["fastapi", "FastAPI"],
    },
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
    detection: {
      // Rails: Gemfile is required; bin/rails or config/routes.rb confirms.
      // The conjunction is encoded as an override in stack-detector.
      rootMarkers: ["Gemfile", "bin/rails", "config/routes.rb"],
    },
  },
  sinatra: {
    name: "Sinatra",
    language: "ruby",
    category: "backend",
    outputDirectory: ".",
    defaultPort: 4567,
    defaultBuildCommand: "bundle install",
    defaultStartCommand: "ruby app.rb",
    detection: {
      rootMarkers: ["Gemfile"],
      deps: ["sinatra"],
    },
  },

  // ── PHP ────────────────────────────────────────────────────────────────────

  // PHP stacks serve `public/` from FrankenPHP (see LANGUAGES.php). `exec` hands
  // the container's PID to frankenphp so SIGTERM drains in-flight requests
  // instead of being swallowed by the shell; SERVER_NAME carries the injected
  // $PORT (a bare `:port` also keeps Caddy's automatic HTTPS out of the way —
  // TLS terminates at the edge). No build command: `composer install` is the
  // INSTALL step, and the build step is where a JS asset pipeline goes (the
  // detector fills it in when the repo has one).
  laravel: {
    name: "Laravel",
    language: "php",
    category: "fullstack",
    outputDirectory: "public",
    defaultPort: 8000,
    defaultBuildCommand: "",
    defaultStartCommand:
      'SERVER_NAME=":$PORT" exec frankenphp run --config /etc/frankenphp/Caddyfile --adapter caddyfile',
    // Everything a stock Laravel app writes lives here: uploads
    // (storage/app), sessions + cache when the drivers are `file`, and the
    // framework's own scratch space. `database/` is deliberately NOT persisted —
    // it holds migrations, so mounting over it would hide the ones a later
    // release adds. A SQLite app should point DB_DATABASE at a persisted path or
    // (better) use a database service.
    persistentPaths: ["storage"],
    detection: {
      rootMarkers: ["artisan", "composer.json"],
      deps: ["laravel/framework"],
    },
  },
  symfony: {
    name: "Symfony",
    language: "php",
    category: "fullstack",
    outputDirectory: "public",
    defaultPort: 8000,
    defaultBuildCommand: "",
    defaultStartCommand:
      'SERVER_NAME=":$PORT" exec frankenphp run --config /etc/frankenphp/Caddyfile --adapter caddyfile',
    // No persistentPaths: Symfony's `var/` is cache + logs, both regenerated,
    // and it has no convention for where user uploads land.
    detection: {
      rootMarkers: ["composer.json", "symfony.lock"],
      deps: ["symfony/framework-bundle"],
    },
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
    productionPaths: ["target"],    // Predominantly a Maven stack; bare-metal builds need `mvn` ensured. Gradle
    // Spring Boot projects still build via their `./gradlew` wrapper (JDK-only).
    requiredTools: ["java", "javac", "maven"],
    detection: {
      rootMarkers: ["pom.xml", "build.gradle", "build.gradle.kts"],
      deps: ["org.springframework.boot:spring-boot-starter-web", "spring-boot"],
      contentPatterns: {
        "pom.xml": "spring[-.]boot",
        "build.gradle": "spring[-.]boot",
        "build.gradle.kts": "spring[-.]boot",
      },
    },
  },
  quarkus: {
    name: "Quarkus",
    language: "java",
    category: "backend",
    outputDirectory: "target",
    defaultPort: 8080,
    defaultBuildCommand: "mvn clean package -DskipTests",
    defaultStartCommand: "java -jar target/quarkus-app/quarkus-run.jar",
    productionPaths: ["target"],    requiredTools: ["java", "javac", "maven"],
    detection: {
      rootMarkers: ["pom.xml", "build.gradle", "build.gradle.kts"],
      deps: ["io.quarkus:quarkus-core", "quarkus"],
      contentPatterns: {
        "pom.xml": "io\\.quarkus",
        "build.gradle": "io\\.quarkus",
        "build.gradle.kts": "io\\.quarkus",
      },
    },
  },

  // ── Kotlin (JVM, Gradle) ─────────────────────────────────────────────────
  // Plain Kotlin/JVM services (Ktor, http4k, or a bare `main`). A Kotlin *Spring
  // Boot* project still matches `springboot` first (its content pattern wins in
  // the rule order), so this catches Kotlin projects that aren't Spring/Quarkus.

  kotlin: {
    name: "Kotlin",
    language: "java",
    category: "backend",
    outputDirectory: "build/libs",
    defaultPort: 8080,
    defaultBuildCommand: "gradle build -x test",
    defaultStartCommand: "java -jar build/libs/*.jar",
    productionPaths: ["build/libs"],    // Gradle-based; bare-metal builds need `gradle` ensured (or the `./gradlew`
    // wrapper, which the detector prefers when present).
    requiredTools: ["java", "javac", "gradle"],
    detection: {
      rootMarkers: ["build.gradle.kts", "build.gradle"],
      contentPatterns: {
        "build.gradle.kts": "kotlin\\s*\\(|org\\.jetbrains\\.kotlin",
        "build.gradle": "org\\.jetbrains\\.kotlin|kotlin[- ]",
      },
    },
  },

  // ── C# / .NET ──────────────────────────────────────────────────────────────

  dotnet: {
    name: ".NET",
    language: "csharp",
    category: "backend",
    // Build runs `dotnet publish -c Release -o publish`, so the artifact is ./publish.
    outputDirectory: "publish",
    defaultPort: 5000,
    defaultBuildCommand: "dotnet publish -c Release -o publish",
    // .NET reads ASPNETCORE_URLS (not $PORT) and defaults to :8080, so bind it
    // explicitly to the injected port. The detector rewrites `app.dll` to the
    // real assembly name (from the .csproj); `app` is the fallback.
    defaultStartCommand: "ASPNETCORE_URLS=http://0.0.0.0:$PORT dotnet publish/app.dll",
    productionPaths: ["publish"],
    detection: {
      // .csproj/.fsproj/.sln are detected by suffix; rootMarkers is decorative
      // here since the suffix-match lives in stack-detector.
    },
  },
  blazor: {
    name: "Blazor",
    language: "csharp",
    // Blazor WebAssembly compiles to a static bundle under publish/wwwroot —
    // it's served as files, not a running server (Blazor Server folds into `dotnet`).
    category: "static",
    outputDirectory: "publish/wwwroot",
    defaultPort: 5000,
    defaultBuildCommand: "dotnet publish -c Release -o publish",
    defaultStartCommand: "",
    productionPaths: ["publish/wwwroot"],
    detection: {
      deps: ["Microsoft.AspNetCore.Components.WebAssembly"],
    },
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
    productionPaths: ["_build/prod/rel"],
    detection: {
      rootMarkers: ["mix.exs"],
      deps: ["phoenix"],
    },
  },

  // ── Generic ────────────────────────────────────────────────────────────────

  node: {
    name: "Node.js",
    language: "javascript",
    category: "backend",
    outputDirectory: "dist",
    defaultPort: 3000,
    defaultBuildCommand: "",
    defaultStartCommand: "node index.js",    detection: {
      rootMarkers: ["package.json"],
    },
  },
  static: {
    name: "Static Site",
    language: "multi",
    category: "static",
    buildImage: "node:22",
    outputDirectory: ".",
    defaultPort: 3000,
    defaultBuildCommand: "",
    defaultStartCommand: "",    detection: {
      rootMarkers: ["index.html"],
    },
  },
  docker: {
    name: "Dockerfile",
    language: "multi",
    category: "docker",
    outputDirectory: ".",
    defaultPort: 3000,
    defaultBuildCommand: "",
    defaultStartCommand: "",
    detection: {
      rootMarkers: ["Dockerfile"],
    },
  },
  "docker-compose": {
    name: "Docker Compose",
    language: "multi",
    category: "services",
    outputDirectory: ".",
    defaultPort: 3000,
    defaultBuildCommand: "",
    defaultStartCommand: "",
    detection: {
      rootMarkers: ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"],
    },
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

  // ── Opinionated openship installs (commands fixed by the runner) ───────────

  webmail: {
    name: "Webmail",
    language: "typescript",
    category: "fullstack",
    outputDirectory: "client/build",
    defaultPort: 4080,
    defaultBuildCommand: "bun run build",
    defaultStartCommand: "bun run src/main.ts",
    // Runs on bun, not node - the toolchain layer installs bun from the catalog.
    requiredTools: ["bun"],
    requiredToolVersions: { bun: "1.2.0" },
  },
} as const satisfies Record<string, StackDefinition>;

// ─── Derived constants (auto-generated, never edit manually) ─────────────────

/** All stack IDs as a type - replaces the old hardcoded `Framework` union */
export type StackId = keyof typeof STACKS;

/** All stack IDs as a runtime array */
export const STACK_IDS = Object.keys(STACKS) as StackId[];

/** All language IDs as a runtime array */
export const LANGUAGE_IDS = Object.keys(LANGUAGES) as Language[];

/** All unique package managers across all languages */
export const ALL_PACKAGE_MANAGERS: string[] = [
  ...new Set(Object.values(LANGUAGES).flatMap((l) => l.packageManagers)),
];

/**
 * Paths always excluded when transferring project files (source or build output).
 *
 * Three categories:
 *  - VCS / source-control:    .git
 *  - Dependency artifacts:    node_modules, vendor (the target re-installs)
 *  - Build / cache artifacts: .next, .vite, .turbo, .cache, .react-router,
 *                             .nuxt, .svelte-kit, .astro, .output, dist,
 *                             build, .nx
 *
 * Framework-specific extras live per-stack via `cacheDirs`. The intent is
 * to ship ONLY the source - the target installs and builds fresh - so the
 * over-the-wire payload stays measured in MB, not GB.
 */
export const TRANSFER_EXCLUDES: readonly string[] = [
  ".git",
  "node_modules",
  "vendor",
  ".next",
  ".vite",
  ".turbo",
  ".cache",
  ".react-router",
  ".nuxt",
  ".svelte-kit",
  ".astro",
  ".output",
  ".nx",
  "dist",
  "build",
  // Runtime state - sqlite DBs, branding uploads, dev-only generated
  // secrets. If a release dir was started locally for testing, these
  // appear next to the static artifacts; we never want to ship them.
  "data",
  ".dev-secrets.json",
];

/**
 * Excludes for transferring a LOCALLY-BUILT project's OUTPUT to the target
 * (buildStrategy=local: build on the API host, ship the result).
 *
 * Unlike TRANSFER_EXCLUDES — which ships source ONLY, for a build-on-target
 * flow — this KEEPS the stack's own build-output directory (e.g. Next.js
 * `.next`, Nuxt `.output`, Vite `dist`), because that compiled output IS the
 * thing we're shipping. Without this the target receives source with no build
 * and `next start` (etc.) fails with "Could not find a production build".
 *
 * Everything else stays excluded: dependencies (reinstalled on the target),
 * VCS, caches (incl. the stack's own `cacheDirs`, e.g. `.next/cache`), and
 * OTHER frameworks' output dirs (harmless — they don't exist for this stack).
 */
export function buildOutputTransferExcludes(
  stackDef?: { outputDirectory?: string; cacheDirs?: readonly string[] },
): string[] {
  const outDir = stackDef?.outputDirectory;
  return [...TRANSFER_EXCLUDES, ...(stackDef?.cacheDirs ?? [])].filter(
    (entry) => entry !== outDir,
  );
}

/**
 * The subset of TRANSFER_EXCLUDES whose names are ALSO ordinary source-folder
 * names — a Next.js `app/.../build` route, a `src/data` content dir, a `dist`
 * source package. Matching these by name at any depth silently deletes real
 * source, so callers must prune them ONLY when they sit at a package root
 * (directly beside a package.json) — i.e. they are a genuine build output. The
 * rest of TRANSFER_EXCLUDES (.git, node_modules, .next, …) are unambiguous and
 * safe to match anywhere.
 */
export const PACKAGE_ROOT_ONLY_EXCLUDES: readonly string[] = ["build", "dist", "data"];

/**
 * Browser-safe predicate for the folder-upload tarball builder: given a
 * repo-relative POSIX path, should it be excluded from the uploaded archive?
 *
 * Shares TRANSFER_EXCLUDES with the server so the client tar and the server's
 * name-based tar fallback prune the same directories. The unambiguous excludes
 * (`.git`, `node_modules`, `.next`, …) are matched at ANY depth; the ambiguous
 * ones (`build`/`dist`/`data`, which are also legitimate source-folder names)
 * are pruned only at the tree ROOT, mirroring PACKAGE_ROOT_ONLY_EXCLUDES — the
 * server re-detects and installs fresh, so a genuine build output at the root
 * is safe to drop while a nested `src/data` is preserved.
 */
const UNAMBIGUOUS_UPLOAD_EXCLUDES: ReadonlySet<string> = new Set(
  TRANSFER_EXCLUDES.filter((name) => !PACKAGE_ROOT_ONLY_EXCLUDES.includes(name)),
);

export function isUploadIgnoredPath(relativePath: string): boolean {
  const segments = relativePath.split("/").filter(Boolean);
  if (segments.length === 0) return false;
  // Unambiguous excludes anywhere in the path.
  if (segments.some((seg) => UNAMBIGUOUS_UPLOAD_EXCLUDES.has(seg))) return true;
  // Ambiguous excludes only when they are the top-level entry.
  if (PACKAGE_ROOT_ONLY_EXCLUDES.includes(segments[0]!)) return true;
  return false;
}

/** Output directories keyed by stack - derived from STACKS */
export const OUTPUT_DIRECTORIES: Record<string, string> = Object.fromEntries(
  Object.entries(STACKS).map(([id, s]) => [id, s.outputDirectory]),
);

/**
 * Every filename that any stack uses as a project-root marker, lowercased.
 * Project-root-detector unions this with workspace/build-tool markers to discover
 * candidate roots in a repo tree. Adding a stack with `detection.rootMarkers`
 * automatically flows here - no parallel list to maintain.
 */
export const STACK_ROOT_MARKERS: ReadonlySet<string> = new Set(
  Object.values(STACKS)
    .flatMap((stack) => (stack as StackDefinition).detection?.rootMarkers ?? [])
    .map((marker) => marker.toLowerCase()),
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

/**
 * Command that ensures the detected JS package manager is on PATH before the
 * install step runs. npm/pnpm/yarn all ship through Node's `corepack` — enabling
 * it installs the pnpm/yarn shims and lets each project's
 * `package.json#packageManager` field select the exact version. Falls back to a
 * global npm install when corepack is unavailable (old Node / no perms), and is
 * fully swallowed so it never fails the build.
 *
 * `bun` gets a presence check instead: corepack doesn't manage it. Inside a
 * container this is a no-op — getBuildImage already resolves bun-eligible stacks
 * to oven/bun, so `command -v bun` short-circuits before the npm fallback (which
 * matters: that image ships no npm). It earns its keep on a BARE target, where we
 * install onto whatever the box already has (see runtime/bare.ts).
 *
 * Returns "" for `npm` (already present) and every non-node PM (in-image).
 */
export function packageManagerEnsureCommand(packageManager?: string): string {
  if (packageManager === "bun") {
    return `(command -v bun >/dev/null 2>&1 || npm i -g bun) >/dev/null 2>&1 || true`;
  }
  if (packageManager !== "pnpm" && packageManager !== "yarn") return "";
  return `(corepack enable ${packageManager} || corepack enable || npm i -g ${packageManager}) >/dev/null 2>&1 || true`;
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
 * Normalizes a framework input (stack ID or display name like "Static Site", "Next.js")
 * to its canonical stack ID ("static", "nextjs", etc.).
 */
export function normalizeFramework(framework?: string | null): string {
  if (!framework) return "unknown";
  const trimmed = framework.trim();
  if (!trimmed) return "unknown";
  const lower = trimmed.toLowerCase();
  if (lower in STACKS) return lower;
  for (const [id, def] of Object.entries(STACKS)) {
    if (def.name.toLowerCase() === lower) return id;
  }
  // Common display aliases
  if (lower === "static site" || lower === "plain html" || lower === "html/js") return "static";
  if (lower === "nextjs" || lower === "next.js" || lower === "next") return "nextjs";
  if (lower === "nuxtjs" || lower === "nuxt.js" || lower === "nuxt") return "nuxt";
  if (lower === "dockerfile" || lower === "docker compose") return "docker";
  return lower;
}

/**
 * Is a project SERVICE-FIRST — i.e. the project itself IS a set of services
 * (a docker-compose / "services" stack), NOT a single/static app that merely
 * had sidecar services added to it? Keyed on the project's own framework, so
 * adding a service to a real app never makes it service-first. Safe for
 * unknown/undefined frameworks (mirrors the API's `isMultiServiceProject`).
 */
export function isServicesFramework(framework?: string | null): boolean {
  if (!framework) return false;
  try {
    return getProjectType(framework as StackId) === "services";
  } catch {
    return framework === "docker-compose";
  }
}

/**
 * Does this stack normally HAVE a build step?
 *
 * The registry already answers this: a stack with no `defaultBuildCommand` is one
 * whose dependency install is the whole story (Express, Hono, plain Node), whose
 * build lives in its own Dockerfile (`docker`), or whose build step is reserved
 * for something optional (PHP: `composer install` is the install step, and the
 * build step only exists when the repo ships a JS asset pipeline).
 *
 * Use it before telling a user that a missing build command looks wrong — for the
 * stacks above it's the normal state, and warning there is noise that trains
 * people to ignore preflight. False for an unknown framework: no declared
 * expectation, nothing to flag.
 */
export function stackExpectsBuildCommand(framework?: string | null): boolean {
  if (!framework || !(framework in STACKS)) return false;
  return !!(STACKS[framework as StackId] as StackDefinition).defaultBuildCommand;
}

/**
 * Hint whether a stack is typically static (no running server).
 * Used as a default for the hasServer toggle - the user can override.
 */
export function isTypicallyStatic(stackId: StackId): boolean {
  const stack = STACKS[stackId] as StackDefinition;
  return (
    (stack.category === "static" || stack.category === "frontend") &&
    !stack.defaultStartCommand
  );
}

// ─── Icon URLs - source of truth for logo/icon display ───────────────────────

const DI = "https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons";

export const STACK_ICONS: Partial<Record<StackId, string>> = {
  // JS/TS - Frontend & Fullstack
  nextjs:      `${DI}/nextjs/nextjs-original.svg`,
  nuxt:        `${DI}/nuxtjs/nuxtjs-original.svg`,
  sveltekit:   `${DI}/svelte/svelte-original.svg`,
  remix:       `${DI}/react/react-original.svg`,
  "tanstack-start": `${DI}/react/react-original.svg`,
  astro:       `${DI}/astro/astro-original.svg`,
  vite:        `${DI}/vitejs/vitejs-original.svg`,
  angular:     `${DI}/angular/angular-original.svg`,
  gatsby:      `${DI}/gatsby/gatsby-original.svg`,
  cra:         `${DI}/react/react-original.svg`,
  vue:         `${DI}/vuejs/vuejs-original.svg`,
  react:       `${DI}/react/react-original.svg`,

  // JS/TS - Backend
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

  // Opinionated installs
  webmail:     `${DI}/typescript/typescript-original.svg`,

  // Generic
  node:        `${DI}/nodejs/nodejs-original.svg`,
  static:      `${DI}/html5/html5-original.svg`,
  docker:      `${DI}/docker/docker-original.svg`,
  "docker-compose": `${DI}/docker/docker-original.svg`,
};
