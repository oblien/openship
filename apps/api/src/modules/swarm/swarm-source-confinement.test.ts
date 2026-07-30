import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertSafeStagedPath,
  readConfinedStackSourceFiles,
  resolveConfinedSourcePath,
  validateConfinedStackSource,
} from "./swarm-source-confinement";

const cleanup: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "openship-swarm-source-"));
  cleanup.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Swarm stack source confinement", () => {
  it("allows nested repository files and enumerates all supported source-side references", async () => {
    const root = await tempRoot();
    await Promise.all([
      mkdir(join(root, "services/api"), { recursive: true }),
      mkdir(join(root, "config"), { recursive: true }),
      mkdir(join(root, "secrets"), { recursive: true }),
      mkdir(join(root, "data"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(root, "services/api/Dockerfile"), "FROM scratch\n"),
      writeFile(join(root, "services/api/.env"), "LOG_LEVEL=info\n"),
      writeFile(join(root, "config/app.yml"), "feature: true\n"),
      writeFile(join(root, "secrets/token.txt"), "not-returned\n"),
      writeFile(join(root, "compose.yaml"), `services:
  api:
    build:
      context: ./services/api
      dockerfile: Dockerfile
    env_file: ./services/api/.env
    volumes: [./data:/var/lib/api]
configs:
  app-config: { file: ./config/app.yml }
secrets:
  api-token: { file: ./secrets/token.txt }
`),
    ]);

    const files = await readConfinedStackSourceFiles(root, ["compose.yaml"]);
    const references = await validateConfinedStackSource(root, files);
    expect(references.map((reference) => reference.field)).toEqual(expect.arrayContaining([
      "composePaths",
      "configs.app-config.file",
      "secrets.api-token.file",
      "services.api.build.context",
      "services.api.build.dockerfile",
      "services.api.env_file",
      "services.api.volumes",
    ]));
  });

  it("rejects traversal, absolute paths, control characters, and escaped symlinks before a Docker command", async () => {
    const root = await tempRoot();
    const outside = await tempRoot();
    await writeFile(join(outside, "secret.txt"), "do-not-read");
    await symlink(outside, join(root, "escape"));

    await expect(resolveConfinedSourcePath(root, "../../etc/shadow", "composePaths")).rejects.toMatchObject({ code: "SWARM_SOURCE_PATH_INVALID" });
    await expect(resolveConfinedSourcePath(root, "/etc/passwd", "composePaths")).rejects.toMatchObject({ code: "SWARM_SOURCE_PATH_INVALID" });
    await expect(resolveConfinedSourcePath(root, "escape/secret.txt", "secrets.api-token.file")).rejects.toMatchObject({ code: "SWARM_SOURCE_PATH_ESCAPE" });
    expect(() => assertSafeStagedPath("compose\n.yaml", "composePaths")).toThrow(/unsafe source path/);
  });

  it("enforces bounded source reads without returning file contents on failure", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "compose.yaml"), "services:\n  api:\n    image: nginx\n");
    await expect(readConfinedStackSourceFiles(root, ["compose.yaml"], { maxFileBytes: 8 })).rejects.toMatchObject({
      code: "SWARM_SOURCE_TOO_LARGE",
    });
  });
});
