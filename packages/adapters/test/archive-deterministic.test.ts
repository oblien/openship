import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  extractArtifact,
  packDeterministicArtifact,
  sha256File,
} from "../src/archive";

const cleanups: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function seedTree(root: string): Promise<void> {
  await mkdir(join(root, "app"), { recursive: true });
  await writeFile(join(root, "index.php"), "<?php echo 1;\n");
  await writeFile(join(root, "app", "Kernel.php"), "<?php class Kernel {}\n");
  await writeFile(join(root, "composer.lock"), '{"content-hash":"abc"}\n');
  // mtime/mode noise must not change the digest
  await writeFile(join(root, ".hidden"), "keep\n");
}

describe("packDeterministicArtifact", () => {
  it("produces the same archive SHA-256 for two packs of the same tree", async () => {
    const a = await tempDir("art-a-");
    const b = await tempDir("art-b-");
    const out = await tempDir("art-out-");
    await seedTree(a);
    await seedTree(b);

    const first = await packDeterministicArtifact({
      sourceDir: a,
      destPath: join(out, "one"),
      source: "local-upload",
      commitSha: "abc1234",
    });
    const second = await packDeterministicArtifact({
      sourceDir: b,
      destPath: join(out, "two"),
      source: "local-upload",
      commitSha: "abc1234",
    });

    expect(first.sha256).toBe(second.sha256);
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await sha256File(first.archivePath)).toBe(first.sha256);
    expect(first.files).toEqual([".hidden", "app/Kernel.php", "composer.lock", "index.php"]);
    expect(first.lockHashes?.["composer.lock"]).toMatch(/^[a-f0-9]{64}$/);
    expect(first.source).toBe("local-upload");
    expect(first.version).toBe(1);
    expect(first.compression).toMatch(/^(gzip|zstd)$/);

    const manifest = JSON.parse(await readFile(first.manifestPath, "utf8"));
    expect(manifest.sha256).toBe(first.sha256);
    expect(manifest.files).toEqual(first.files);
  });

  it("changes the digest when a file changes", async () => {
    const tree = await tempDir("art-chg-");
    const out = await tempDir("art-chg-out-");
    await seedTree(tree);
    const before = await packDeterministicArtifact({
      sourceDir: tree,
      destPath: join(out, "before"),
      source: "git-prebuilt",
    });
    await writeFile(join(tree, "index.php"), "<?php echo 2;\n");
    const after = await packDeterministicArtifact({
      sourceDir: tree,
      destPath: join(out, "after"),
      source: "git-prebuilt",
    });
    expect(after.sha256).not.toBe(before.sha256);
  });

  it("extracts the packed tree back to the same files", async () => {
    const tree = await tempDir("art-src-");
    const out = await tempDir("art-pack-");
    const dest = await tempDir("art-dest-");
    await seedTree(tree);
    const packed = await packDeterministicArtifact({
      sourceDir: tree,
      destPath: join(out, "app"),
      source: "server-prepared",
    });
    await extractArtifact(packed.archivePath, dest);
    expect(await readFile(join(dest, "index.php"), "utf8")).toBe("<?php echo 1;\n");
    expect(await readFile(join(dest, "composer.lock"), "utf8")).toBe('{"content-hash":"abc"}\n');
  });
});
