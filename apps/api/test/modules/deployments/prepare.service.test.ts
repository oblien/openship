import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveProjectInfo } from "../../../src/modules/deployments/prepare.service";

describe("resolveProjectInfo", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("reports missing required Compose variables instead of returning no services", async () => {
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

    await expect(resolveProjectInfo({ source: "local", path: tempDir })).rejects.toThrow(
      "Could not parse the Docker Compose file: Set API_PASSWORD",
    );
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
});
