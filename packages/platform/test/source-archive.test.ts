import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { Header, type HeaderData } from "tar";
import { archiveSourceDirectory, MAX_SOURCE_BYTES, validateSourceDirectory } from "../src/source-files";
import { extractSourceArchive } from "../src/source-archive";

const owned: string[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "openship-archive-test-"));
  owned.push(path);
  return path;
}
afterEach(async () => { await Promise.all(owned.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

function archive(entries: Array<HeaderData & { content?: string }>) {
  const chunks: Buffer[] = [];
  for (const { content = "", ...data } of entries) {
    const bytes = Buffer.from(content);
    const header = new Header({ mode: 0o644, type: "File", size: bytes.length, ...data });
    header.encode();
    chunks.push(header.block!, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}

describe("owned source archives", () => {
  it.each(["temporary directory", "ancestor", "symlink"])(
    "rejects an archive source containing staging through its %s without touching old files",
    async kind => {
      const sandbox = await directory(), staging = join(sandbox, "tmp");
      await mkdir(staging);
      await writeFile(join(staging, "openship-upload-old.tar.gz"), "operator-owned leftover");
      const alias = join(sandbox, "tmp-link");
      await symlink(staging, alias);
      const source = kind === "ancestor" ? sandbox : kind === "symlink" ? alias : staging;
      let packed: Awaited<ReturnType<typeof archiveSourceDirectory>> | undefined;
      try {
        await expect(archiveSourceDirectory(source, { temporaryRoot: staging, signal: AbortSignal.timeout(500) }).then(value => { packed = value; return value; }))
          .rejects.toThrow(/temporary directory/);
      } finally { await packed?.dispose(); }
      expect(await readdir(staging)).toEqual(["openship-upload-old.tar.gz"]);
      expect(await readFile(join(staging, "openship-upload-old.tar.gz"), "utf8")).toBe("operator-owned leftover");
    },
  );

  it("resolves symlink parents before creating a new staging directory inside the source", async () => {
    const sandbox = await directory(), source = join(sandbox, "source"), alias = join(sandbox, "link");
    await mkdir(source);
    await symlink(source, alias);
    await expect(archiveSourceDirectory(source, { temporaryRoot: join(alias, "new", "tmp") })).rejects.toThrow(/temporary directory/);
    expect(await readdir(source)).toEqual([]);
  });

  it("allows a common path prefix and removes staging after repeated successful archives", async () => {
    const sandbox = await directory(), source = join(sandbox, "tmp-project"), staging = join(sandbox, "tmp");
    await mkdir(source);
    await writeFile(join(source, "index.html"), "source content");
    for (let attempt = 0; attempt < 3; attempt++) {
      const packed = await archiveSourceDirectory(source, { temporaryRoot: staging });
      const destination = await directory();
      try {
        await extractSourceArchive(packed.path, destination);
        expect(await readdir(destination)).toEqual(["index.html"]);
        expect(await readFile(join(destination, "index.html"), "utf8")).toBe("source content");
      } finally { await packed.dispose(); }
      expect(await readdir(staging)).toEqual([]);
    }
  });

  it("packs and extracts files and internal symlinks without a system tar executable", async () => {
    const source = await directory(), destination = await directory();
    await mkdir(join(source, "dist"));
    await writeFile(join(source, "dist/index.html"), "generated build");
    await writeFile(join(source, "__upload.tar.gz"), "ordinary source file");
    await symlink("dist/index.html", join(source, "index.html"));
    const packed = await archiveSourceDirectory(source);
    try {
      await extractSourceArchive(packed.path, destination);
      expect(await readFile(join(destination, "index.html"), "utf8")).toBe("generated build");
      expect(await readFile(join(destination, "__upload.tar.gz"), "utf8")).toBe("ordinary source file");
    } finally { await packed.dispose(); }
  });

  it.each<HeaderData>([
    { path: "../escape" }, { path: "/absolute" }, { path: "C:/absolute" }, { path: "a\\..\\escape" },
    { path: "link", type: "SymbolicLink", linkpath: "../../outside" },
    { path: "link", type: "Link", linkpath: "../outside" },
    { path: "fifo", type: "FIFO" }, { path: "huge", size: MAX_SOURCE_BYTES + 1 },
  ])("rejects unsafe archive member $path before writing source files", async member => {
    const root = await directory(), destination = join(root, "source");
    await mkdir(destination);
    const path = join(root, "archive.tar.gz");
    await writeFile(path, archive([{ path: "safe.txt", content: "safe" }, member]));
    await expect(extractSourceArchive(path, destination)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(await readdir(destination)).toEqual([]);
  });

  it("rejects duplicate paths and truncated gzip payloads", async () => {
    const root = await directory(), destination = join(root, "source"), path = join(root, "archive.tar.gz");
    await mkdir(destination);
    const bytes = archive([{ path: "same", content: "one" }, { path: "same", content: "two" }]);
    await writeFile(path, bytes);
    await expect(extractSourceArchive(path, destination)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await writeFile(path, bytes.subarray(0, 10));
    await expect(extractSourceArchive(path, destination)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(await readdir(destination)).toEqual([]);
  });

  it("accepts hard links only to a regular file within the same archive", async () => {
    const root = await directory(), destination = join(root, "source"), path = join(root, "archive.tar.gz");
    await mkdir(destination);
    await writeFile(path, archive([{ path: "original", content: "source bytes" }, { path: "alias", type: "Link", linkpath: "original" }]));
    await extractSourceArchive(path, destination);
    expect(await readFile(join(destination, "alias"), "utf8")).toBe("source bytes");
  });

  it("rejects symlink cycles during local source validation", async () => {
    const source = await directory();
    await mkdir(join(source, "inner"));
    await symlink("..", join(source, "inner/loop"));
    await expect(validateSourceDirectory(source)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});
