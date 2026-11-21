import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { buildFolderTarGz } from "./tarGz";

const LONG_PATHS = [
  // >100 bytes, non-ASCII: multi-byte UTF-8 makes bytes != UTF-16 length.
  "docs/content/zh/指南/快速开始/安装与配置/部署到自托管服务器/使用容器镜像进行部署/常见问题与故障排除.md",
  "public/imágenes/categorías/decoración/habitación-pequeña/fotografía-de-demostración-número-uno-versión-final.jpg",
  // >100 bytes, ASCII only.
  `src/${"a".repeat(40)}/${"b".repeat(40)}/${"c".repeat(40)}/index.ts`,
];

function folderFile(path: string, body: string): File {
  const file = new File([body], path.split("/").pop()!);
  Object.defineProperty(file, "webkitRelativePath", { value: `myapp/${path}` });
  return file;
}

async function buildTar(paths: string[]): Promise<Buffer> {
  const { blob } = await buildFolderTarGz(paths.map((p) => folderFile(p, `content of ${p}`)));
  return gunzipSync(Buffer.from(await blob.arrayBuffer()));
}

/** Split a PAX extended-header body into its raw records (as bytes). */
function paxRecords(body: Buffer): { declared: number; actual: number }[] {
  const out: { declared: number; actual: number }[] = [];
  let pos = 0;
  while (pos < body.length && body[pos] !== 0) {
    const space = body.indexOf(0x20, pos);
    const declared = Number(body.subarray(pos, space).toString("ascii"));
    const newline = body.indexOf(0x0a, space);
    out.push({ declared, actual: newline + 1 - pos });
    pos = newline + 1;
  }
  return out;
}

describe("buildFolderTarGz long paths", () => {
  // The server extracts uploads with node-tar, which skips a PAX record whose
  // declared length is wrong and falls back to the truncated 100-byte ustar
  // name: the file lands at a cut-off path without any error.
  it.each(LONG_PATHS)("writes a PAX path record whose length is its UTF-8 byte count: %s", async (path) => {
    expect(Buffer.byteLength(path)).toBeGreaterThan(100);
    const archive = await buildTar([path]);
    expect(String.fromCharCode(archive[156]!)).toBe("x");
    const size = parseInt(archive.subarray(124, 136).toString("ascii"), 8);
    const body = archive.subarray(512, 512 + size);
    const records = paxRecords(body);
    expect(records).toHaveLength(1);
    expect(records[0]!.declared).toBe(records[0]!.actual);
    expect(records[0]!.actual).toBe(size);
    expect(body.toString("utf8")).toBe(`${size} path=${path}\n`);
  });
});
