import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resolveFromReader,
  resolveProjectInfo,
  resolveProjectSourceEnv,
} from "@repo/platform/engine/modules/deployments/prepare.service";

describe("resolveProjectInfo", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("reads the listed Dockerfile path on case-sensitive sources", async () => {
    const reads: string[] = [];
    const info = await resolveFromReader(
      {
        listDirectory: async () => [{ name: "Dockerfile", type: "file" }],
        readJson: async () => undefined,
        listTree: async () => [],
        readText: async (path) => {
          reads.push(path);
          return path === "Dockerfile" ? "FROM node:22-alpine\nEXPOSE 8080\n" : undefined;
        },
      },
      {
        name: "web",
        full_name: "example/web",
        owner: "example",
        private: false,
        default_branch: "main",
      },
      "main",
    );
    expect(info).toMatchObject({ stack: "docker", port: 8080, startCommand: "" });
    expect(reads).toContain("Dockerfile");
    expect(reads).not.toContain("dockerfile");
  });

  it.each(["./", "apps/web"])(
    "uses Dockerfile runtime defaults at %s despite Bun/Next scripts",
    async (rootDirectory) => {
      const repo = await mkdtemp(join(tmpdir(), "openship-docker-runtime-"));
      tempDirs.push(repo);
      const root = join(repo, rootDirectory);
      await mkdir(root, { recursive: true });
      if (rootDirectory !== "./") {
        await writeFile(
          join(repo, "package.json"),
          JSON.stringify({
            private: true,
            workspaces: ["apps/*"],
            packageManager: "pnpm@10.0.0",
          }),
        );
        await writeFile(join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      }
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({
          name: "web",
          dependencies: { next: "^16.0.0" },
          scripts: {
            build: "next build",
            start: "node custom-server.js --port 20127",
          },
        }),
      );
      await writeFile(join(root, "bun.lock"), "{}");
      await writeFile(
        join(root, "next.config.mjs"),
        "export default { output: 'standalone' };\n",
      );
      await writeFile(
        join(root, "Dockerfile"),
        'FROM node:22-alpine\nEXPOSE 20128\nENTRYPOINT ["/entrypoint.sh"]\nCMD ["node", "custom-server.js"]\n',
      );

      const info = await resolveProjectInfo({
        source: "local",
        path: repo,
        rootDirectory,
      });
      expect(info).toMatchObject({
        stack: "docker",
        projectType: "docker",
        port: 20128,
        installCommand: "",
        buildCommand: "",
        startCommand: "",
      });

      // A declared override is intentional, even when it differs from image CMD.
      await writeFile(
        join(root, "openship.json"),
        JSON.stringify({ startCommand: "node worker.js", port: 9000 }),
      );
      const overridden = await resolveProjectInfo({
        source: "local",
        path: repo,
        rootDirectory,
      });
      expect(overridden).toMatchObject({
        stack: "docker",
        startCommand: "node worker.js",
        port: 9000,
      });
    },
  );

  it.each(["public", "web-assets"])(
    "keeps a Node server instead of promoting its %s assets",
    async (assets) => {
      const tempDir = await mkdtemp(join(tmpdir(), "openship-server-assets-"));
      tempDirs.push(tempDir);
      await writeFile(
        join(tempDir, "package.json"),
        JSON.stringify({
          scripts: { start: "node server.mjs" },
          engines: { node: ">=24" },
        }),
      );
      await writeFile(join(tempDir, "server.mjs"), "import { createServer } from 'node:http';\n");
      await mkdir(join(tempDir, assets));
      await writeFile(join(tempDir, assets, "index.html"), "<!doctype html><main>Application</main>");

      const info = await resolveProjectInfo({ source: "local", path: tempDir });
      expect(info).toMatchObject({
        stack: "node",
        rootDirectory: "./",
        startCommand: "npm run start",
      });
      expect(info.monorepoApps).toBeUndefined();

      // An explicit root selection remains authoritative for a separate static deploy.
      const selected = await resolveProjectInfo({
        source: "local",
        path: tempDir,
        rootDirectory: assets,
      });
      expect(selected).toMatchObject({ stack: "static", rootDirectory: assets, startCommand: "" });
    },
  );

  it("keeps a Vite app's local-dev Compose separate unless explicitly selected (#959)", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "openship-app-with-compose-"));
    tempDirs.push(tempDir);
    await writeFile(join(tempDir, "package.json"), JSON.stringify({
      name: "app", scripts: { build: "vite build" }, devDependencies: { vite: "^6.0.0" },
    }));
    await writeFile(join(tempDir, "vite.config.ts"), "export default {};\n");
    await writeFile(join(tempDir, "docker-compose.yml"), [
      "services:",
      "  postgres:",
      "    image: postgres:16-alpine",
      "    environment:",
      "      POSTGRES_PASSWORD: local-dev-only",
    ].join("\n"));

    const app = await resolveProjectInfo({ source: "local", path: tempDir });
    expect(app.stack).toBe("vite");
    expect(app.projectType).toBe("app");
    expect(app.services).toBeUndefined();

    const compose = await resolveProjectInfo({
      source: "local", path: tempDir, composePath: "docker-compose.yml",
    });
    expect(compose.projectType).toBe("services");
    expect(compose.services).toEqual([
      expect.objectContaining({ name: "postgres", image: "postgres:16-alpine" }),
    ]);
  });

  it("parses a Compose project's services when its root also looks like a Vite app (#1020)", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "openship-compose-behind-vite-"));
    tempDirs.push(tempDir);
    await writeFile(
      join(tempDir, "package.json"),
      JSON.stringify({
        name: "app",
        scripts: { build: "vite build" },
        devDependencies: { vite: "^6.0.0" },
      }),
    );
    await writeFile(join(tempDir, "vite.config.ts"), "export default {};\n");
    await writeFile(join(tempDir, "Dockerfile"), "FROM node:22-alpine\n");
    await writeFile(
      join(tempDir, "compose.yaml"),
      ["services:", "  app:", "    build: .", "  caddy:", "    image: caddy:2"].join("\n"),
    );

    const scan = await resolveProjectInfo({ source: "local", path: tempDir });
    expect(scan.stack).toBe("docker");
    expect(scan.services).toBeUndefined();

    const compose = await resolveProjectInfo({
      source: "local",
      path: tempDir,
      expectCompose: true,
    });
    expect(compose.projectType).toBe("services");
    expect(compose.services?.map((service) => service.name)).toEqual(["app", "caddy"]);
  });

  it("reports a required Compose variable as a value to collect, not a load failure", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "openship-prepare-"));
    tempDirs.push(tempDir);

    await writeFile(
      join(tempDir, "compose.yaml"),
      [
        "services:",
        "  web:",
        "    image: nginx:alpine",
        "    environment:",
        "      API_PASSWORD: ${API_PASSWORD:?Set API_PASSWORD}",
      ].join("\n"),
    );

    // #472: this used to throw, so the wizard showed "Failed to Load Repository"
    // and the project could never be imported at all — for a file whose only
    // problem is a value the wizard exists to ask for.
    const info = await resolveProjectInfo({ source: "local", path: tempDir });

    expect(info.services?.map((s) => s.name)).toEqual(["web"]);
    expect(info.services?.[0]?.environmentMeta?.API_PASSWORD).toMatchObject({
      source: "missing",
      required: true,
    });
    expect(info.missingRequiredEnv).toEqual([
      { variable: "API_PASSWORD", message: "Set API_PASSWORD" },
    ]);
  });

  it("interpolates required Compose variables from the configured deploy env", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "openship-prepare-"));
    tempDirs.push(tempDir);

    // #383: compose lives outside the repo root (#330) and declares a required
    // variable. The user supplied it in the Openship deploy configuration, so
    // the scan must interpolate it instead of reporting the file as unparseable.
    await mkdir(join(tempDir, "deploy", "docker-compose"), { recursive: true });
    await writeFile(
      join(tempDir, "deploy", "docker-compose", "docker-compose.yaml"),
      [
        "services:",
        "  db:",
        "    image: postgres:16-alpine",
        "    environment:",
        "      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD in .env}",
      ].join("\n"),
    );

    const info = await resolveProjectInfo({
      source: "local",
      path: tempDir,
      composePath: "deploy/docker-compose",
      env: { POSTGRES_PASSWORD: "s3cret" },
    });

    expect(info.services?.find((s) => s.name === "db")?.environment).toMatchObject({
      POSTGRES_PASSWORD: "s3cret",
    });
  });

  it("combines Compose .env and deployment env when resolving an image", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "openship-prepare-"));
    tempDirs.push(tempDir);
    await writeFile(join(tempDir, ".env"), "CHANNEL=stable\n");
    await writeFile(
      join(tempDir, "compose.yaml"),
      ["services:", "  api:", "    image: ghcr.io/acme/api:${CHANNEL}-${MY_VERSION}"].join("\n"),
    );

    const info = await resolveProjectInfo({
      source: "local",
      path: tempDir,
      env: { MY_VERSION: "1.2.3" },
    });

    expect(info.services?.[0]).toMatchObject({
      image: "ghcr.io/acme/api:stable-1.2.3",
      advanced: {
        imageTemplate: {
          expression: "ghcr.io/acme/api:${CHANNEL}-${MY_VERSION}",
          unresolvedVariables: [],
          sourceValue: "ghcr.io/acme/api:stable-",
        },
      },
    });
  });

  it("#795 carries native service build args and source-env provenance", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "openship-build-args-"));
    tempDirs.push(tempDir);
    await writeFile(join(tempDir, "Dockerfile"), "FROM node:22-alpine\nARG SERVER_URL\n");
    await writeFile(
      join(tempDir, "openship.json"),
      JSON.stringify({
        env: {
          SERVER_URL: "https://source.example.com",
          PAYLOAD_SECRET: { value: "source-secret", secret: true },
        },
        services: [
          {
            name: "admin",
            build: ".",
            dockerfile: "Dockerfile",
            buildArgs: { SERVER_URL: null, PAYLOAD_SECRET: null, CHANNEL: "stable" },
            env: { SERVER_URL: "https://runtime.example.com" },
          },
        ],
      }),
    );

    const info = await resolveProjectInfo({ source: "local", path: tempDir });

    expect(info.projectType).toBe("services");
    expect(info.rootEnv).toMatchObject({
      SERVER_URL: "https://source.example.com",
      PAYLOAD_SECRET: "source-secret",
    });
    expect(info.openshipEnv).toEqual({
      SERVER_URL: "https://source.example.com",
      PAYLOAD_SECRET: { value: "source-secret", secret: true },
    });
    expect(info.services?.[0]).toMatchObject({
      build: ".",
      dockerfile: "Dockerfile",
      buildArgs: { SERVER_URL: null, PAYLOAD_SECRET: null, CHANNEL: "stable" },
      environment: { SERVER_URL: "https://runtime.example.com" },
    });
  });

  it("scans a subpath project's own openship.json when its rootDirectory is pinned", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "openship-subpath-services-"));
    tempDirs.push(tempDir);
    await writeFile(
      join(tempDir, "openship.json"),
      JSON.stringify({
        framework: "fastapi",
        env: { ROOT_APP_ONLY: "not-for-go-api" },
      }),
    );
    await mkdir(join(tempDir, "go-api"));
    await writeFile(join(tempDir, "go-api", "Dockerfile"), "FROM golang:1.25-alpine\n");
    await writeFile(
      join(tempDir, "go-api", "openship.json"),
      JSON.stringify({
        framework: "docker-compose",
        rootDirectory: "./",
        env: { API_URL: "https://child.example.com" },
        services: [{ name: "backend", build: "." }],
      }),
    );

    expect((await resolveProjectInfo({ source: "local", path: tempDir })).services ?? []).toEqual(
      [],
    );
    const info = await resolveProjectInfo({
      source: "local",
      path: tempDir,
      rootDirectory: "go-api",
    });
    expect(info.rootDirectory).toBe("go-api");
    expect(info.services).toEqual([expect.objectContaining({ name: "backend", build: "." })]);
    expect(info.openshipEnv).toEqual({ API_URL: "https://child.example.com" });
    expect(info.rootEnv).toEqual({ API_URL: "https://child.example.com" });
  });

  describe("repository-root config for a saved subfolder", () => {
    async function repoWithBuildDirectory() {
      const path = await mkdtemp(join(tmpdir(), "openship-subfolder-config-"));
      tempDirs.push(path);
      await mkdir(join(path, "deploy"));
      await writeFile(join(path, "deploy", "Dockerfile"), "FROM node:22-alpine\n");
      return path;
    }

    it("retains native service definitions across an initial scan and refresh", async () => {
      const path = await repoWithBuildDirectory();
      await writeFile(
        join(path, "openship.json"),
        JSON.stringify({
          rootDirectory: "deploy",
          services: [{ name: "api", build: "." }],
        }),
      );

      const initial = await resolveProjectInfo({ source: "local", path });
      expect(initial.rootDirectory).toBe("deploy");
      expect(initial.services).toEqual([expect.objectContaining({ name: "api", build: "." })]);

      const refreshed = await resolveProjectInfo({
        source: "local",
        path,
        rootDirectory: initial.rootDirectory,
      });

      expect(refreshed.rootDirectory).toBe("deploy");
      expect(refreshed.projectType).toBe("services");
      expect(refreshed.services).toEqual(initial.services);
    });

    it("retains env defaults and a declared Compose path across refreshes", async () => {
      const path = await repoWithBuildDirectory();
      await writeFile(
        join(path, "openship.json"),
        JSON.stringify({
          composePath: "deploy/stack.yml",
          env: { API_URL: "https://api.example.com" },
        }),
      );
      await writeFile(join(path, "deploy", ".env"), "CHANNEL=stable\n");
      await writeFile(
        join(path, "deploy", "stack.yml"),
        [
          "services:",
          "  api:",
          "    build: .",
          "    environment:",
          "      API_URL: ${API_URL:?Set API_URL}",
          "      CHANNEL: ${CHANNEL}",
        ].join("\n"),
      );

      const initial = await resolveProjectInfo({ source: "local", path });
      expect(initial.rootDirectory).toBe("deploy");
      expect(initial.openshipEnv).toEqual({ API_URL: "https://api.example.com" });
      expect(initial.services?.[0]?.environment).toEqual({
        API_URL: "https://api.example.com",
        CHANNEL: "stable",
      });

      for (const composePath of [undefined, initial.composePath]) {
        const refreshed = await resolveProjectInfo({
          source: "local",
          path,
          rootDirectory: initial.rootDirectory,
          composePath,
        });

        expect(refreshed.rootDirectory).toBe("deploy");
        expect(refreshed.composePath).toBe("deploy/stack.yml");
        expect(refreshed.openshipEnv).toEqual(initial.openshipEnv);
        expect(refreshed.services?.[0]?.environment).toEqual(initial.services?.[0]?.environment);
        expect(refreshed.missingRequiredEnv).toBeUndefined();
      }

      const overridden = await resolveProjectInfo({
        source: "local",
        path,
        rootDirectory: "deploy",
        env: { API_URL: "https://operator.example.com" },
      });
      expect(overridden.services?.[0]?.environment).toEqual({
        API_URL: "https://operator.example.com",
        CHANNEL: "stable",
      });
    });

    it.each(["{}", "", "{ broken json"])(
      "does not inherit another app's config when the subfolder manifest contains %j",
      async (content) => {
        const path = await repoWithBuildDirectory();
        await writeFile(
          join(path, "openship.json"),
          JSON.stringify({
            env: { ROOT_APP_SECRET: "belongs-to-root-app" },
            services: [{ name: "root-app", image: "nginx:alpine" }],
          }),
        );
        await writeFile(join(path, "deploy", "openship.json"), content);

        const info = await resolveProjectInfo({ source: "local", path, rootDirectory: "deploy" });

        expect(info.rootDirectory).toBe("deploy");
        expect(info.services).toBeUndefined();
        expect(info.openshipEnv).toBeUndefined();
        if (content === "{ broken json") expect(info.configDiagnostics?.wholeFile).toBe(true);
      },
    );
  });

  it("#795 retains a Compose build-arg template alongside openship.json env", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "openship-compose-build-args-"));
    tempDirs.push(tempDir);
    await writeFile(join(tempDir, "Dockerfile"), "FROM node:22-alpine\nARG SERVER_URL\n");
    await writeFile(
      join(tempDir, "compose.yaml"),
      [
        "services:",
        "  admin:",
        "    build:",
        "      context: .",
        "      dockerfile: Dockerfile",
        "      args:",
        "        SERVER_URL: ${SERVER_URL:?set SERVER_URL}",
      ].join("\n"),
    );
    await writeFile(
      join(tempDir, "openship.json"),
      JSON.stringify({ env: { SERVER_URL: "https://source.example.com" } }),
    );

    const info = await resolveProjectInfo({ source: "local", path: tempDir });

    expect(info.services?.[0]).toMatchObject({
      build: ".",
      dockerfile: "Dockerfile",
      // Raw source stays frozen for the final deployment-env interpolation.
      buildArgs: { SERVER_URL: "${SERVER_URL:?set SERVER_URL}" },
      advanced: { buildArgTemplateKeys: ["SERVER_URL"] },
    });
    expect(info.openshipEnv).toEqual({ SERVER_URL: "https://source.example.com" });
    expect(info.missingRequiredEnv).toBeUndefined();
  });

  it("reads single-app source env without parsing an unrelated Compose file", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "openship-source-env-"));
    tempDirs.push(tempDir);
    await mkdir(join(tempDir, "apps", "web"), { recursive: true });
    await writeFile(join(tempDir, "compose.yaml"), "services: [this is not valid");
    await writeFile(join(tempDir, "apps", "web", ".env"), "LOCAL_DEFAULT=from-dotenv\n");
    await writeFile(
      join(tempDir, "OpenShip.json"),
      JSON.stringify({
        env: {
          PUBLIC_URL: "https://app.example.com",
          AUTH_SECRET: { value: "source-secret", secret: true },
        },
      }),
    );

    await expect(
      resolveProjectSourceEnv({ source: "local", path: tempDir }, "apps/web"),
    ).resolves.toEqual({
      rootEnv: {
        LOCAL_DEFAULT: "from-dotenv",
        PUBLIC_URL: "https://app.example.com",
        AUTH_SECRET: "source-secret",
      },
      openshipEnv: {
        PUBLIC_URL: "https://app.example.com",
        AUTH_SECRET: { value: "source-secret", secret: true },
      },
    });
  });

  it('normalizes an undetected package manager to "npm" instead of the internal "unknown" sentinel (#415)', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "openship-prepare-"));
    tempDirs.push(tempDir);

    // A compose-only subfolder with no manifest anywhere (package.json, go.mod,
    // requirements.txt, ...) — detectPackageManager() legitimately falls back to
    // "unknown" here, but that's an internal sentinel PackageManagerEnum never
    // accepted. Echoing it back verbatim let the dashboard round-trip it
    // straight into project creation and 400 with "Expected union value".
    await mkdir(join(tempDir, "infra", "9router"), { recursive: true });
    await writeFile(
      join(tempDir, "infra", "9router", "docker-compose.yml"),
      ["services:", "  9router:", "    image: decolua/9router:latest"].join("\n"),
    );

    const info = await resolveProjectInfo({
      source: "local",
      path: tempDir,
      composePath: "infra/9router",
    });

    expect(info.packageManager).toBe("npm");
  });

  it("reports invalid Compose YAML instead of returning no services", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "openship-prepare-"));
    tempDirs.push(tempDir);

    await writeFile(join(tempDir, "compose.yaml"), "services:\n  web: [unterminated\n");

    await expect(resolveProjectInfo({ source: "local", path: tempDir })).rejects.toThrow(
      "Could not parse the Docker Compose file:",
    );
  });

  it("reads compose files from the selected nested root for local projects", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "openship-prepare-"));
    tempDirs.push(tempDir);

    await writeFile(
      join(tempDir, "package.json"),
      JSON.stringify({
        name: "root-api",
        dependencies: { express: "^5.0.0" },
        scripts: { start: "node server.js" },
      }),
    );

    await mkdir(join(tempDir, "apps", "services"), { recursive: true });
    await writeFile(
      join(tempDir, "apps", "services", "compose.yml"),
      [
        "services:",
        "  web:",
        "    image: nginx:alpine",
        "    environment:",
        "      PORT: ${PORT:-8080}",
      ].join("\n"),
    );
    await writeFile(join(tempDir, "apps", "services", ".env"), "PORT=9090\n");

    const result = await resolveProjectInfo({ source: "local", path: tempDir });

    expect(result.rootDirectory).toBe("apps/services");
    expect(result.projectType).toBe("services");
    expect(result.stack).toBe("docker-compose");
    expect(result.services?.map((service) => service.name)).toEqual(["web"]);
    expect(result.rootEnv).toEqual({ PORT: "9090" });
  });

  // ── Declared compose path (issue #330) ────────────────────────────────────
  //
  // The detector only PROMOTES a nested compose root when the repo root is
  // itself promotable (see canPromoteNestedApp). A root that detects as a
  // frontend/fullstack app — the common "app at root, manifests in /deploy"
  // shape — silently deployed as a single app instead, with no way to say
  // otherwise. These cover the explicit override.
  describe("declared composePath", () => {
    /** Repo root that detects as Next.js (NOT promotable), compose in a subpath. */
    async function nextRootWithNestedCompose(composeFileName = "docker-compose.yml") {
      const tempDir = await mkdtemp(join(tmpdir(), "openship-compose-path-"));
      tempDirs.push(tempDir);

      await writeFile(
        join(tempDir, "package.json"),
        JSON.stringify({
          name: "web-app",
          dependencies: { next: "^15.0.0", react: "^19.0.0" },
          scripts: { build: "next build", start: "next start" },
        }),
      );
      await writeFile(join(tempDir, "next.config.js"), "module.exports = {};\n");

      const composeDir = join(tempDir, "deploy", "docker-compose");
      await mkdir(composeDir, { recursive: true });
      await writeFile(
        join(composeDir, composeFileName),
        [
          "services:",
          "  api:",
          "    build: ./api",
          "    environment:",
          "      PORT: ${PORT:-8080}",
          "  cache:",
          "    image: redis:7-alpine",
        ].join("\n"),
      );
      await writeFile(join(composeDir, ".env"), "PORT=9090\n");

      return tempDir;
    }

    it("without the override, a non-promotable root still deploys as a single app", async () => {
      const tempDir = await nextRootWithNestedCompose();

      const result = await resolveProjectInfo({ source: "local", path: tempDir });

      // This is the #330 bug: the nested compose is simply not seen.
      expect(result.projectType).toBe("app");
      expect(result.stack).toBe("nextjs");
      expect(result.services).toBeUndefined();
    });

    it("uses the compose file when the path names it", async () => {
      const tempDir = await nextRootWithNestedCompose();

      const result = await resolveProjectInfo({
        source: "local",
        path: tempDir,
        composePath: "deploy/docker-compose/docker-compose.yml",
      });

      expect(result.projectType).toBe("services");
      expect(result.rootDirectory).toBe("deploy/docker-compose");
      expect(result.composePath).toBe("deploy/docker-compose/docker-compose.yml");
      expect(result.services?.map((service) => service.name)).toEqual(["api", "cache"]);
      // `.env` is read next to the compose file, per compose's own semantics.
      expect(result.rootEnv).toEqual({ PORT: "9090" });
      expect(result.services?.[0]?.environment).toEqual({ PORT: "9090" });
    });

    it("uses the directory holding the compose file", async () => {
      const tempDir = await nextRootWithNestedCompose();

      const result = await resolveProjectInfo({
        source: "local",
        path: tempDir,
        composePath: "deploy/docker-compose",
      });

      expect(result.projectType).toBe("services");
      expect(result.rootDirectory).toBe("deploy/docker-compose");
      expect(result.services?.map((service) => service.name)).toEqual(["api", "cache"]);
    });

    it("accepts a non-standard compose filename, which detection can never match", async () => {
      const tempDir = await nextRootWithNestedCompose("stack.yml");

      const result = await resolveProjectInfo({
        source: "local",
        path: tempDir,
        composePath: "deploy/docker-compose/stack.yml",
      });

      expect(result.projectType).toBe("services");
      expect(result.services?.map((service) => service.name)).toEqual(["api", "cache"]);
    });

    it("tolerates a leading ./ and surrounding slashes", async () => {
      const tempDir = await nextRootWithNestedCompose();

      const result = await resolveProjectInfo({
        source: "local",
        path: tempDir,
        composePath: "./deploy/docker-compose/",
      });

      expect(result.rootDirectory).toBe("deploy/docker-compose");
      expect(result.projectType).toBe("services");
    });

    it("treats a blank path as no pin at all, not as the repo root", async () => {
      const tempDir = await nextRootWithNestedCompose();

      // The wizard/API send "" to CLEAR a pin. A blank must fall back to normal
      // detection — never resolve to the repo root and pin projectType there.
      for (const composePath of ["", "   "]) {
        const result = await resolveProjectInfo({ source: "local", path: tempDir, composePath });
        expect(result.projectType).toBe("app");
        expect(result.stack).toBe("nextjs");
        expect(result.composePath).toBeUndefined();
      }
    });

    it("errors when the declared path holds no compose file", async () => {
      const tempDir = await nextRootWithNestedCompose();

      await expect(
        resolveProjectInfo({ source: "local", path: tempDir, composePath: "deploy" }),
      ).rejects.toThrow(/No compose file found at "deploy"/);
    });

    it("errors when the declared path does not exist at all", async () => {
      const tempDir = await nextRootWithNestedCompose();

      await expect(
        resolveProjectInfo({ source: "local", path: tempDir, composePath: "nope/here" }),
      ).rejects.toThrow(/was not found in the repository/);
    });

    it("rejects a path that escapes the repository", async () => {
      const tempDir = await nextRootWithNestedCompose();

      await expect(
        resolveProjectInfo({ source: "local", path: tempDir, composePath: "../outside" }),
      ).rejects.toThrow(/must be inside the repository/);
    });

    it("is seeded by openship.json, and an explicit value wins over it", async () => {
      const tempDir = await nextRootWithNestedCompose();

      // A SECOND compose file, so the two sources are distinguishable.
      const otherDir = join(tempDir, "ops");
      await mkdir(otherDir, { recursive: true });
      await writeFile(
        join(otherDir, "compose.yml"),
        ["services:", "  worker:", "    image: busybox"].join("\n"),
      );

      await writeFile(
        join(tempDir, "openship.json"),
        JSON.stringify({ composePath: "deploy/docker-compose" }),
      );

      // Seeded from the repo file when the caller declares nothing.
      const seeded = await resolveProjectInfo({ source: "local", path: tempDir });
      expect(seeded.projectType).toBe("services");
      expect(seeded.rootDirectory).toBe("deploy/docker-compose");
      expect(seeded.services?.map((service) => service.name)).toEqual(["api", "cache"]);

      // Configs only seed defaults — the caller's own value is the truth.
      const overridden = await resolveProjectInfo({
        source: "local",
        path: tempDir,
        composePath: "ops",
      });
      expect(overridden.rootDirectory).toBe("ops");
      expect(overridden.services?.map((service) => service.name)).toEqual(["worker"]);
    });

    it("skips monorepo discovery — a declared compose path means one services project", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "openship-compose-path-mono-"));
      tempDirs.push(tempDir);

      // A workspace root with two deployable sub-apps would normally detect as a
      // monorepo and offer the multi-app flow.
      await writeFile(
        join(tempDir, "package.json"),
        JSON.stringify({ name: "monorepo", workspaces: ["apps/*"] }),
      );
      await writeFile(join(tempDir, "pnpm-workspace.yaml"), "packages:\n  - 'apps/*'\n");
      for (const app of ["web", "admin"]) {
        await mkdir(join(tempDir, "apps", app), { recursive: true });
        await writeFile(
          join(tempDir, "apps", app, "package.json"),
          JSON.stringify({
            name: app,
            dependencies: { next: "^15.0.0" },
            scripts: { build: "next build", start: "next start" },
          }),
        );
        await writeFile(join(tempDir, "apps", app, "package-lock.json"), "{}");
      }

      await mkdir(join(tempDir, "deploy"), { recursive: true });
      await writeFile(
        join(tempDir, "deploy", "docker-compose.yml"),
        ["services:", "  api:", "    image: node:22-alpine"].join("\n"),
      );

      const result = await resolveProjectInfo({
        source: "local",
        path: tempDir,
        composePath: "deploy",
      });

      expect(result.projectType).toBe("services");
      expect(result.monorepoApps).toBeUndefined();
      expect(result.services?.map((service) => service.name)).toEqual(["api"]);
    });

    it("surfaces a broken declared compose file instead of falling back", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "openship-compose-path-bad-"));
      tempDirs.push(tempDir);

      await mkdir(join(tempDir, "deploy"), { recursive: true });
      await writeFile(
        join(tempDir, "deploy", "docker-compose.yml"),
        "services:\n  api:\n   image: nginx\n  bad\n    - [unclosed\n",
      );

      await expect(
        resolveProjectInfo({ source: "local", path: tempDir, composePath: "deploy" }),
      ).rejects.toThrow(/Could not parse the Docker Compose file at "deploy"/);
    });
  });

  /**
   * #641: the overlay was lenient AND silent — a typo'd openship.json applied
   * nothing (or only some fields) and said nothing anywhere, so the deploy ran on
   * heuristics and looked like the file wasn't there. Leniency stays; the silence
   * doesn't.
   */
  describe("openship.json diagnostics (#641)", () => {
    async function repoWithConfig(contents?: string) {
      const tempDir = await mkdtemp(join(tmpdir(), "openship-config-diag-"));
      tempDirs.push(tempDir);
      await writeFile(
        join(tempDir, "package.json"),
        JSON.stringify({ name: "x", scripts: { build: "vite build" } }),
      );
      if (contents !== undefined) await writeFile(join(tempDir, "openship.json"), contents);
      return tempDir;
    }

    it("reports a refused field and still applies the valid siblings", async () => {
      const tempDir = await repoWithConfig('{ "framework": "nextjsx", "port": 8080 }');
      const info = await resolveProjectInfo({ source: "local", path: tempDir });

      // The leniency is the point: `port` still overlays. What changed is that
      // the refused `framework` is now reported instead of vanishing.
      expect(info.port).toBe(8080);
      expect(info.configDiagnostics?.errors.some((e) => e.startsWith("framework:"))).toBe(true);
      expect(info.configDiagnostics?.warnings).toEqual([]);
    });

    it("reports monorepo declarations that cannot be matched to discovered apps (#873)", async () => {
      const tempDir = await repoWithConfig(
        JSON.stringify({
          monorepo: {
            apps: [{ name: "worker", rootDirectory: "private-path-SENTINEL" }],
            workspace: { packageManager: "npm", prepareCommand: "secret-command-SENTINEL" },
          },
        }),
      );
      const info = await resolveProjectInfo({ source: "local", path: tempDir });
      expect(info.monorepoApps).toBeUndefined();
      expect(info.configDiagnostics?.warnings).toEqual([
        expect.stringMatching(/^monorepo\.apps\[0\]:.*did not match/),
        expect.stringMatching(/^monorepo\.workspace:.*no workspace was detected/),
      ]);
      expect(JSON.stringify(info.configDiagnostics)).not.toContain("SENTINEL");
    });

    it("applies matched workspace overrides and reports only the missing app (#873)", async () => {
      const tempDir = await repoWithConfig(
        JSON.stringify({
          monorepo: {
            apps: [
              { name: "web", rootDirectory: "./apps/web/", port: 8080 },
              { name: "missing", rootDirectory: "apps/missing" },
            ],
          },
        }),
      );
      await writeFile(
        join(tempDir, "package.json"),
        JSON.stringify({ name: "workspace", workspaces: ["apps/*"] }),
      );
      for (const app of ["web", "admin"]) {
        await mkdir(join(tempDir, "apps", app), { recursive: true });
        await writeFile(
          join(tempDir, "apps", app, "package.json"),
          JSON.stringify({
            name: app,
            dependencies: { next: "^15.0.0" },
            scripts: { build: "next build", start: "next start" },
          }),
        );
        await writeFile(join(tempDir, "apps", app, "package-lock.json"), "{}");
      }
      const info = await resolveProjectInfo({ source: "local", path: tempDir });
      expect(info.projectType).toBe("monorepo");
      expect(info.monorepoApps).toHaveLength(2);
      expect(info.monorepoApps?.find((app) => app.rootDirectory === "apps/web")?.port).toBe(8080);
      expect(info.configDiagnostics?.warnings).toEqual([
        expect.stringMatching(/^monorepo\.apps\[1\]:/),
      ]);
    });

    it("reports an unrecognized top-level key as a warning, not an error", async () => {
      // The issue's headline case. `buildComand` produces ZERO errors — it lands
      // entirely in the warnings channel, so an errors-only fix would not report
      // the most common real typo at all.
      const tempDir = await repoWithConfig('{ "buildComand": "npm run b", "port": 3000 }');
      const info = await resolveProjectInfo({ source: "local", path: tempDir });

      expect(info.configDiagnostics?.errors).toEqual([]);
      expect(info.configDiagnostics?.warnings.some((w) => w.includes("buildComand"))).toBe(true);
    });

    it("reports an unparseable file without echoing its bytes", async () => {
      // Both V8 and JSC quote the offending token back (JSC unbounded), so
      // forwarding the engine's message would push openship.json's `env` values
      // out through the metadata-tier detect endpoint. The message must be ours.
      const tempDir = await repoWithConfig('{ "env": { "DB": "P@ssw0rd-LEAK-SENTINEL-xyz" }');
      const info = await resolveProjectInfo({ source: "local", path: tempDir });

      expect(JSON.stringify(info.configDiagnostics)).not.toContain("LEAK-SENTINEL");
      expect(info.configDiagnostics?.errors[0]).toMatch(/not valid JSON/);
      expect(info.configDiagnostics?.wholeFile).toBe(true);
    });

    it("reports a non-object root as a whole-file failure", async () => {
      const tempDir = await repoWithConfig("null");
      const info = await resolveProjectInfo({ source: "local", path: tempDir });

      expect(info.configDiagnostics?.errors[0]).toMatch(/must be a JSON object/);
      expect(info.configDiagnostics?.wholeFile).toBe(true);
    });

    it("does not flag a field-level refusal as a whole-file failure", async () => {
      // The severity split drives the wizard's copy: "nothing applied" vs "the
      // rest applied". A partial failure must never claim the louder one.
      const tempDir = await repoWithConfig('{ "framework": "nextjsx", "port": 8080 }');
      const info = await resolveProjectInfo({ source: "local", path: tempDir });

      expect(info.configDiagnostics?.wholeFile).toBeUndefined();
    });

    it("strips control characters out of the messages", async () => {
      // These messages quote the repo's own key names back, and they land in a
      // server log line and a terminal. A newline forges a second log entry; an
      // ESC[2K repaints the CLI line. Neither may survive to a sink.
      const esc = String.fromCharCode(27);
      const tempDir = await repoWithConfig(
        JSON.stringify({
          [`x\n[openship.json] attacker/forged: all clean`]: 1,
          env: { [`${esc}[2K\r${esc}[32m ok applied cleanly${esc}[0m`]: 5 },
        }),
      );
      const info = await resolveProjectInfo({ source: "local", path: tempDir });

      const all = [
        ...(info.configDiagnostics?.errors ?? []),
        ...(info.configDiagnostics?.warnings ?? []),
      ];
      expect(all.length).toBeGreaterThan(0);
      for (const msg of all) {
        expect(msg).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
      }
    });

    it("bounds each message so one cannot become a payload", async () => {
      const tempDir = await repoWithConfig(JSON.stringify({ ["k".repeat(5000)]: 1 }));
      const info = await resolveProjectInfo({ source: "local", path: tempDir });

      const longest = Math.max(...(info.configDiagnostics?.warnings ?? [""]).map((w) => w.length));
      expect(longest).toBeLessThanOrEqual(240);
    });

    it("omits configDiagnostics for a clean openship.json", async () => {
      const tempDir = await repoWithConfig('{ "framework": "vite", "port": 3000 }');
      const info = await resolveProjectInfo({ source: "local", path: tempDir });

      expect(info.configDiagnostics).toBeUndefined();
    });

    it("omits configDiagnostics for a repo with no openship.json", async () => {
      // The payload for an unaffected repo has to stay exactly what it was.
      const tempDir = await repoWithConfig();
      const info = await resolveProjectInfo({ source: "local", path: tempDir });

      expect(info.configDiagnostics).toBeUndefined();
      expect("configDiagnostics" in info).toBe(false);
    });
  });
});
