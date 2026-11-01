import { test, expect } from "vitest";
import { packBuildContext } from "./docker";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import type { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
test("BuildKit context starts with root directory and preserves allowlist/ignore", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pack-regression-"));
  try {
    await writeFile(dir + "/Dockerfile", "FROM scratch\n");
    await mkdir(dir + "/assets");
    await writeFile(dir + "/assets/ok.txt", "public");
    await writeFile(dir + "/assets/secret.txt", "forbidden");
    await writeFile(dir + "/outside.txt", "excluded");
    const p = packBuildContext(dir, ["Dockerfile", "assets"], undefined, (name) =>
      name.endsWith("secret.txt"),
    );
    const chunks = [];
    for await (const b of p.body) chunks.push(Buffer.from(b));
    const tar = gunzipSync(Buffer.concat(chunks));
    const names = [];
    for (let at = 0; at + 512 <= tar.length; ) {
      const h = tar.subarray(at, at + 512);
      const name = h.subarray(0, 100).toString().replace(/\0.*$/s, "");
      if (!name) break;
      names.push(name);
      const size = parseInt(h.subarray(124, 136).toString().replace(/\0.*$/s, "").trim(), 8) || 0;
      at += 512 + Math.ceil(size / 512) * 512;
    }
    expect(names[0]).toBe(".");
    expect(names).toContain("Dockerfile");
    expect(names).toContain("assets/ok.txt");
    expect(names).not.toContain("outside.txt");
    expect(names).not.toContain("assets/secret.txt");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("missing explicit entry aborts and captures ENOENT", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pack-missing-"));
  try {
    const p = packBuildContext(dir, ["ghost.txt"]);
    p.body.on("data", () => {});
    await Promise.race([
      new Promise((resolve) => p.abortSignal.addEventListener("abort", resolve, { once: true })),
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
    expect(p.abortSignal.aborted).toBe(true);
    expect(p.takeError()?.message).toMatch(/ENOENT/);
    (p.body as Readable).destroy();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("cancellation forwards reason and detaches after handoff", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pack-cancel-"));
  try {
    await writeFile(dir + "/real.txt", "ok");
    const cancel = new AbortController();
    const p = packBuildContext(dir, ["real.txt"], cancel.signal);
    cancel.abort("cancelled");
    expect(p.abortSignal.aborted).toBe(true);
    expect(p.abortSignal.reason).toBe("cancelled");
    p.detachCancellation();
    p.body.resume();
    const second = new AbortController();
    const q = packBuildContext(dir, ["real.txt"], second.signal);
    q.detachCancellation();
    second.abort();
    expect(q.abortSignal.aborted).toBe(false);
    for await (const b of q.body) {
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
