import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { detectStack, type RepoFile } from "../../src/lib/stack-detector";
import {
  STACKS,
  LANGUAGES,
  collectDependencies,
  getRuntimeImage,
  type StackId,
  type StackDefinition,
} from "@repo/core";

/**
 * Per-stack recipe validation. Loads the real fixtures in `fixtures/deploy/`
 * and asserts the detector resolves each into the correct recipe — package
 * manager, install/build/start commands, output/production paths, port, build
 * image, and required toolchain. This is the red/green signal for "is a stack
 * ready to deploy": if the recipe is wrong here, the deploy is wrong too.
 *
 * Inline cases below the fixtures cover paths that would need extra files in the
 * fixtures (package-manager variants, build-tool wrappers, port config).
 */

const FIXTURES_DIR = fileURLToPath(new URL("../../../../fixtures/deploy", import.meta.url));

/** Read a fixture directory into the shape `detectStack` consumes. */
function loadFixture(name: string): {
  files: RepoFile[];
  fileContents: Record<string, string>;
  packageJson?: Record<string, unknown>;
} {
  const dir = join(FIXTURES_DIR, name);
  const files: RepoFile[] = [];
  const fileContents: Record<string, string> = {};
  let packageJson: Record<string, unknown> | undefined;

  for (const entry of readdirSync(dir)) {
    const isDir = statSync(join(dir, entry)).isDirectory();
    files.push({ name: entry, type: isDir ? "dir" : "file" });
    if (isDir) continue;
    const content = readFileSync(join(dir, entry), "utf8");
    fileContents[entry.toLowerCase()] = content;
    if (entry === "package.json") {
      try {
        packageJson = JSON.parse(content);
      } catch {
        /* leave undefined */
      }
    }
  }

  return { files, fileContents, packageJson };
}

/** Tools a stack requires (its override, else the language default). */
function requiredTools(stack: StackId): readonly string[] {
  const def = STACKS[stack] as StackDefinition;
  return def.requiredTools ?? LANGUAGES[def.language].requiredTools;
}

describe("deploy fixtures resolve to the correct recipe", () => {
  it("node → node recipe", () => {
    const { files, fileContents, packageJson } = loadFixture("node");
    const r = detectStack(files, packageJson, fileContents);
    expect(r.stack).toBe("node");
    expect(r.packageManager).toBe("npm");
    expect(r.startCommand).toBe("npm run start");
    expect(r.port).toBe(3000);
  });

  it("go → go recipe", () => {
    const { files, fileContents } = loadFixture("go");
    const r = detectStack(files, undefined, fileContents);
    expect(r.stack).toBe("go");
    expect(r.packageManager).toBe("go");
    expect(r.buildCommand).toBe("go build -o app .");
    expect(r.startCommand).toBe("./app");
    expect(r.productionPaths).toEqual(["app"]);
    expect(r.port).toBe(8080);
  });

  it("rust (axum) → axum recipe with the crate binary name derived from Cargo.toml", () => {
    const { files, fileContents } = loadFixture("rust-axum");
    const r = detectStack(files, undefined, fileContents);
    expect(r.stack).toBe("axum");
    expect(r.packageManager).toBe("cargo");
    expect(r.buildCommand).toBe("cargo build --release");
    expect(r.startCommand).toBe("./target/release/hello_axum");
    expect(r.productionPaths).toEqual(["target/release/hello_axum"]);
    expect(r.port).toBe(3000);
  });

  it("python (fastapi) → fastapi recipe", () => {
    const { files, fileContents } = loadFixture("python-fastapi");
    const r = detectStack(files, undefined, fileContents);
    expect(r.stack).toBe("fastapi");
    expect(r.packageManager).toBe("pip");
    expect(r.buildCommand).toBe("pip install -r requirements.txt");
    expect(r.startCommand).toBe("uvicorn main:app --host 0.0.0.0 --port 8000");
    expect(r.port).toBe(8000);
  });

  it("spring boot → springboot recipe on the Maven build image", () => {
    const { files, fileContents } = loadFixture("springboot");
    const r = detectStack(files, undefined, fileContents);
    expect(r.stack).toBe("springboot");
    expect(r.packageManager).toBe("maven");
    expect(r.buildCommand).toBe("mvn clean package -DskipTests");
    expect(r.startCommand).toBe("java -jar target/*.jar");
    expect(r.buildImage).toBe("maven:3.9-eclipse-temurin-21");
    expect(requiredTools("springboot")).toContain("maven");
  });

  it("kotlin → kotlin recipe (Gradle)", () => {
    const { files, fileContents } = loadFixture("kotlin");
    const r = detectStack(files, undefined, fileContents);
    expect(r.stack).toBe("kotlin");
    expect(r.packageManager).toBe("gradle");
    expect(r.buildCommand).toBe("gradle build -x test");
    expect(r.startCommand).toBe("java -jar build/libs/*.jar");
    expect(r.outputDirectory).toBe("build/libs");
    expect(r.buildImage).toBe("maven:3.9-eclipse-temurin-21");
    expect(requiredTools("kotlin")).toContain("gradle");
  });
});

describe("package-manager-aware Python install", () => {
  it("pyproject (PEP 621) → uv", () => {
    const r = detectStack([{ name: "pyproject.toml" }, { name: "main.py" }], undefined, {
      "pyproject.toml": '[project]\nname = "svc"\ndependencies = ["fastapi", "uvicorn"]\n',
    });
    expect(r.packageManager).toBe("uv");
    expect(r.buildCommand).toBe("pip install uv && uv sync");
  });

  it("pyproject with [tool.poetry] → poetry", () => {
    const r = detectStack([{ name: "pyproject.toml" }], undefined, {
      "pyproject.toml": '[tool.poetry]\nname = "svc"\n[tool.poetry.dependencies]\npython = "^3.12"\nflask = "^3.0"\n',
    });
    expect(r.packageManager).toBe("poetry");
    expect(r.buildCommand).toBe("pip install poetry && poetry install --no-root");
  });

  it("django keeps collectstatic alongside the resolved install", () => {
    const r = detectStack([{ name: "manage.py" }, { name: "requirements.txt" }], undefined, {
      "requirements.txt": "django==5.0\n",
    });
    expect(r.stack).toBe("django");
    expect(r.buildCommand).toBe("pip install -r requirements.txt && python manage.py collectstatic --noinput");
  });
});

describe("PEP 621 [project].dependencies", () => {
  const deps = (toml: string) => Object.keys(collectDependencies({ "pyproject.toml": toml }));

  it("reads dependencies listed after another array-valued key", () => {
    expect(
      deps(
        '[project]\nname = "svc"\nauthors = [{ name = "Ada", email = "ada@example.com" }]\ndependencies = ["fastapi", "uvicorn"]\n',
      ),
    ).toEqual(["fastapi", "uvicorn"]);

    expect(
      deps(
        '[project]\nname = "svc"\nclassifiers = ["Private :: Do Not Upload"]\ndependencies = ["flask"]\n',
      ),
    ).toEqual(["flask"]);
  });

  it("keeps reading past a requirement that carries extras", () => {
    expect(
      deps('[project]\nname = "svc"\ndependencies = ["uvicorn[standard]", "fastapi"]\n'),
    ).toEqual(["uvicorn", "fastapi"]);
    expect(
      deps(
        '[project]\nname = "svc"\ndependencies = ["fastapi", "uvicorn[standard]", "sqlalchemy"]\n',
      ),
    ).toEqual(["fastapi", "uvicorn", "sqlalchemy"]);
  });

  it("stops at the end of the [project] table", () => {
    expect(
      deps(
        '[project]\nname = "svc"\ndependencies = ["fastapi"]\n\n[tool.pytest.ini_options]\naddopts = ["-q"]\n',
      ),
    ).toEqual(["fastapi"]);
    expect(deps('[project]\nname = "svc"\n\n[tool.uv]\ndependencies = ["ruff"]\n')).toEqual([]);
  });

  it("resolves the framework recipe for a manifest with project metadata", () => {
    const r = detectStack([{ name: "pyproject.toml" }, { name: "main.py" }], undefined, {
      "pyproject.toml":
        '[project]\nname = "svc"\nrequires-python = ">=3.12"\nauthors = [{ name = "Ada" }]\ndependencies = ["fastapi", "uvicorn"]\n',
    });
    expect(r.stack).toBe("fastapi");
    expect(r.startCommand).toBe("uvicorn main:app --host 0.0.0.0 --port 8000");
  });
});

describe("JVM build-tool wrapper preference", () => {
  it("Maven project with mvnw uses the wrapper", () => {
    const r = detectStack([{ name: "pom.xml" }, { name: "mvnw" }], undefined, {
      "pom.xml": "<project><parent><artifactId>spring-boot-starter-parent</artifactId></parent></project>",
    });
    expect(r.stack).toBe("springboot");
    expect(r.buildCommand).toBe("./mvnw clean package -DskipTests");
  });

  it("Gradle/Kotlin project with gradlew uses the wrapper", () => {
    const r = detectStack([{ name: "build.gradle.kts" }, { name: "gradlew" }], undefined, {
      "build.gradle.kts": 'plugins { kotlin("jvm") version "2.0.0" }',
    });
    expect(r.stack).toBe("kotlin");
    expect(r.buildCommand).toBe("./gradlew build -x test");
  });
});

describe("Rust binary name derivation", () => {
  it("falls back to the literal 'app' when Cargo.toml has no package name", () => {
    const r = detectStack([{ name: "Cargo.toml" }], undefined, {
      "Cargo.toml": '[dependencies]\naxum = "0.7"\n',
    });
    expect(r.stack).toBe("axum");
    expect(r.startCommand).toBe("./target/release/app");
    expect(r.productionPaths).toEqual(["target/release/app"]);
  });

  it("prefers an explicit [[bin]] name over the package name", () => {
    const r = detectStack([{ name: "Cargo.toml" }], undefined, {
      "Cargo.toml": '[package]\nname = "the_crate"\n\n[[bin]]\nname = "server"\n\n[dependencies]\naxum = "0.7"\n',
    });
    expect(r.startCommand).toBe("./target/release/server");
  });
});

describe("JVM port detection from Spring config", () => {
  it("reads a hardcoded server.port", () => {
    const r = detectStack([{ name: "pom.xml" }], undefined, {
      "pom.xml": "<project><parent><artifactId>spring-boot-starter-parent</artifactId></parent></project>",
      "application.properties": "server.port=9091\n",
    });
    expect(r.port).toBe(9091);
  });

  it("ignores ${PORT:8080} (runtime injects PORT) and keeps the stack default", () => {
    const r = detectStack([{ name: "pom.xml" }], undefined, {
      "pom.xml": "<project><parent><artifactId>spring-boot-starter-parent</artifactId></parent></project>",
      "application.properties": "server.port=${PORT:8080}\n",
    });
    expect(r.port).toBe(8080);
  });

  /** `application.yml`, where a `port:` key belongs to whichever mapping encloses it. */
  const yamlPort = (yml: string) =>
    detectStack([{ name: "pom.xml" }], undefined, {
      "pom.xml":
        "<project><parent><artifactId>spring-boot-starter-parent</artifactId></parent></project>",
      "application.yml": yml,
    }).port;

  it("reads server.port from a YAML block", () => {
    expect(yamlPort("server:\n  port: 8081\n")).toBe(8081);
    expect(yamlPort('server:\n  port: "8081"\n')).toBe(8081);
    expect(yamlPort("server:\n  ssl:\n    enabled: true\n  port: 8443\n")).toBe(8443);
    expect(yamlPort("server: {port: 8081}\n")).toBe(8081);
  });

  it("keeps the stack default when only another mapping declares a port", () => {
    expect(
      yamlPort("server:\n  servlet:\n    context-path: /api\nspring:\n  mail:\n    port: 587\n"),
    ).toBe(8080);
    expect(yamlPort("spring:\n  data:\n    redis:\n      port: 6379\n")).toBe(8080);
    expect(yamlPort("spring:\n  datasource:\n    port: 5432\n")).toBe(8080);
    expect(yamlPort("server:\n  # port: 9999\n  servlet:\n    context-path: /api\n")).toBe(8080);
  });

  it("prefers the top-level server.port over management.server.port", () => {
    expect(yamlPort("management:\n  server:\n    port: 9091\nserver:\n  port: 8081\n")).toBe(8081);
  });

  it("still reads a top-level bare port", () => {
    expect(yamlPort("port: 7000\n")).toBe(7000);
  });
});

describe(".NET recipe", () => {
  it("dotnet fixture → assembly name derived from the .csproj, port wired via ASPNETCORE_URLS", () => {
    const { files, fileContents } = loadFixture("dotnet");
    const r = detectStack(files, undefined, fileContents);
    expect(r.stack).toBe("dotnet");
    expect(r.startCommand).toBe("ASPNETCORE_URLS=http://0.0.0.0:$PORT dotnet publish/HelloApi.dll");
    expect(r.outputDirectory).toBe("publish");
    expect(r.buildImage).toBe("mcr.microsoft.com/dotnet/sdk:8.0");
    expect(r.port).toBe(5000);
  });

  it("falls back to app.dll when only a .sln is present (no .csproj to name from)", () => {
    const r = detectStack([{ name: "MyApp.sln" }], undefined, {});
    expect(r.stack).toBe("dotnet");
    expect(r.startCommand).toBe("ASPNETCORE_URLS=http://0.0.0.0:$PORT dotnet publish/app.dll");
  });

  it("Blazor WASM is treated as a static site (no server start command)", () => {
    const r = detectStack([{ name: "Client.csproj" }], undefined, {
      "client.csproj": "<Project><ItemGroup><PackageReference Include=\"Microsoft.AspNetCore.Components.WebAssembly\" /></ItemGroup></Project>",
    });
    expect(r.stack).toBe("blazor");
    expect(r.category).toBe("static");
    expect(r.startCommand).toBe("");
    expect(r.outputDirectory).toBe("publish/wwwroot");
  });
});

describe("PHP FrankenPHP recipe", () => {
  it("laravel fixture → frankenphp serving public/, composer as the INSTALL step", () => {
    const { files, fileContents } = loadFixture("laravel");
    const r = detectStack(files, undefined, fileContents);
    expect(r.stack).toBe("laravel");
    expect(r.packageManager).toBe("composer");
    expect(r.installCommand).toBe("composer install --no-dev --optimize-autoloader");
    // No JS in the fixture → no asset build. The build step is NOT a second
    // composer install (which is what it used to be).
    expect(r.buildCommand).toBe("");
    expect(r.startCommand).toContain("exec frankenphp run");
    expect(r.startCommand).toContain('SERVER_NAME=":$PORT"');
    expect(r.startCommand).not.toContain("php-fpm");
    expect(r.startCommand).not.toContain("envsubst");
    expect(r.buildImage).toBe("php:8.4-cli");
    expect(getRuntimeImage("laravel")).toBe("dunglas/frankenphp:1-php8.4-bookworm");
  });

  it("a laravel app with a vite frontend gets a real asset build command", () => {
    const r = detectStack(
      [
        { name: "artisan" },
        { name: "composer.json" },
        { name: "package.json" },
        { name: "package-lock.json" },
        { name: "vite.config.js" },
      ],
      { scripts: { build: "vite build", dev: "vite" } },
      { "composer.json": JSON.stringify({ require: { "laravel/framework": "^12.0" } }) },
    );
    expect(r.stack).toBe("laravel");
    expect(r.installCommand).toBe("composer install --no-dev --optimize-autoloader");
    expect(r.buildCommand).toBe("npm i --force && npm run build");
  });

  it("picks the JS package manager from the lockfile, not the project's composer", () => {
    const r = detectStack(
      [
        { name: "artisan" },
        { name: "composer.json" },
        { name: "package.json" },
        { name: "pnpm-lock.yaml" },
      ],
      { scripts: { build: "vite build" } },
      { "composer.json": JSON.stringify({ require: { "laravel/framework": "^12.0" } }) },
    );
    expect(r.packageManager).toBe("composer");
    expect(r.buildCommand).toBe("pnpm install && pnpm build");
  });

  it("symfony also serves via frankenphp (no dev server)", () => {
    const r = detectStack([{ name: "composer.json" }, { name: "symfony.lock" }], undefined, {
      "composer.json": JSON.stringify({ require: { "symfony/framework-bundle": "^7.0" } }),
    });
    expect(r.stack).toBe("symfony");
    expect(r.startCommand).toContain("exec frankenphp run");
    expect(r.startCommand).not.toContain("php -S");
    expect(getRuntimeImage("symfony")).toBe("dunglas/frankenphp:1-php8.4-bookworm");
  });
});

describe("commented-out entries in dependency manifests", () => {
  const gemfile = (sinatra: string) =>
    `source "https://rubygems.org"\ngem "puma"\ngem "rake"\n${sinatra}`;
  const mixExs = (phoenix: string) =>
    `defmodule App.MixProject do\n  defp deps do\n    [\n      {:jason, "~> 1.4"},\n${phoenix}    ]\n  end\nend\n`;

  it("a commented gem does not select the Sinatra recipe", () => {
    const r = detectStack([{ name: "Gemfile" }, { name: "main.rb" }], undefined, {
      Gemfile: gemfile('# gem "sinatra"\n'),
    });
    expect(r.stack).toBe("unknown");
  });

  it("a declared gem still selects the Sinatra recipe", () => {
    const r = detectStack([{ name: "Gemfile" }, { name: "main.rb" }], undefined, {
      Gemfile: gemfile('gem "sinatra"\n'),
    });
    expect(r.stack).toBe("sinatra");
  });

  it("a commented mix.exs dep tuple does not select the Phoenix recipe", () => {
    const r = detectStack([{ name: "mix.exs" }, { name: "lib", type: "dir" }], undefined, {
      "mix.exs": mixExs('      # {:phoenix, "~> 1.7"},\n'),
    });
    expect(r.stack).not.toBe("phoenix");
  });

  it("a declared mix.exs dep tuple still selects the Phoenix recipe", () => {
    const r = detectStack([{ name: "mix.exs" }, { name: "lib", type: "dir" }], undefined, {
      "mix.exs": mixExs('      {:phoenix, "~> 1.7"},\n'),
    });
    expect(r.stack).toBe("phoenix");
    expect(r.startCommand).toBe("_build/prod/rel/app/bin/app start");
  });
});
