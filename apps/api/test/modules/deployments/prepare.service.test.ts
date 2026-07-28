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

  it("honors an explicitly configured Compose root", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "openship-prepare-root-"));
    tempDirs.push(tempDir);

    await writeFile(
      join(tempDir, "docker-compose.yml"),
      ["services:", "  unrelated:", "    image: nginx:alpine"].join("\n"),
    );
    await mkdir(join(tempDir, "stacks", "leverageai"), { recursive: true });
    await writeFile(
      join(tempDir, "stacks", "leverageai", "compose.yml"),
      [
        "services:",
        "  backend:",
        "    image: ghcr.io/example/backend:v1.2.3",
        "  frontend:",
        "    image: ghcr.io/example/web:v1.2.3",
      ].join("\n"),
    );

    const result = await resolveProjectInfo({
      source: "local",
      path: tempDir,
      rootDirectory: "stacks/leverageai",
    });

    expect(result.rootDirectory).toBe("stacks/leverageai");
    expect(result.services?.map((service) => service.name)).toEqual(["backend", "frontend"]);
  });
});
