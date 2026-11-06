import { describe, expect, it } from "vitest";
import { lstat, mkdir, mkdtemp, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { linkMacosKeychain } from "../src/engine/modules/assistant/native-target";

async function fixture() {
  const base = await mkdtemp("/tmp/openship-keychain-");
  const realHome = join(base, "real-home");
  const isolatedHome = join(base, "isolated-home");
  await mkdir(join(realHome, "Library", "Keychains"), { recursive: true });
  await mkdir(isolatedHome, { recursive: true });
  return { base, realHome, isolatedHome };
}

describe("linkMacosKeychain (#1614)", () => {
  it("links the real keychain directory into the isolated home on macOS", async () => {
    const { base, realHome, isolatedHome } = await fixture();
    try {
      await linkMacosKeychain(isolatedHome, realHome, "darwin");
      const link = join(isolatedHome, "Library", "Keychains");
      expect((await lstat(link)).isSymbolicLink()).toBe(true);
      expect(await readlink(link)).toBe(join(realHome, "Library", "Keychains"));
      // Idempotent: a second run keeps the same link.
      await linkMacosKeychain(isolatedHome, realHome, "darwin");
      expect(await readlink(link)).toBe(join(realHome, "Library", "Keychains"));
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("replaces a stale link pointing somewhere else", async () => {
    const { base, realHome, isolatedHome } = await fixture();
    try {
      const other = join(base, "other-keychains");
      await mkdir(other, { recursive: true });
      await mkdir(join(isolatedHome, "Library"), { recursive: true });
      await symlink(other, join(isolatedHome, "Library", "Keychains"));
      await linkMacosKeychain(isolatedHome, realHome, "darwin");
      expect(await readlink(join(isolatedHome, "Library", "Keychains"))).toBe(
        join(realHome, "Library", "Keychains"),
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("leaves a real directory at the link path alone", async () => {
    const { base, realHome, isolatedHome } = await fixture();
    try {
      const existing = join(isolatedHome, "Library", "Keychains");
      await mkdir(existing, { recursive: true });
      await writeFile(join(existing, "keep.txt"), "keep");
      await linkMacosKeychain(isolatedHome, realHome, "darwin");
      expect((await lstat(existing)).isDirectory()).toBe(true);
      expect(await readlink(existing).catch(() => null)).toBeNull();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("does nothing when the real keychain directory is absent", async () => {
    const { base, realHome, isolatedHome } = await fixture();
    try {
      await rm(join(realHome, "Library", "Keychains"), { recursive: true });
      await linkMacosKeychain(isolatedHome, realHome, "darwin");
      await expect(lstat(join(isolatedHome, "Library", "Keychains"))).rejects.toThrow();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("does nothing on non-macOS platforms", async () => {
    const { base, realHome, isolatedHome } = await fixture();
    try {
      await linkMacosKeychain(isolatedHome, realHome, "linux");
      await expect(lstat(join(isolatedHome, "Library", "Keychains"))).rejects.toThrow();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
