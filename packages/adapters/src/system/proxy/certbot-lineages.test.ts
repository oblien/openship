import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { CommandExecutor } from "../../types";
import { certbotLineageDirs } from "./certbot-lineages";

describe("certificate lineage discovery", () => {
  const names = [
    "example.com",
    "example.com-0001",
    "example.com-0002",
    "example.com-backup",
    "example.com-0002.old",
    "example.com.evil",
    "other.example.com-0001",
  ];

  test("local stores return only this hostname's canonical and numbered lineages", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openship-lineage-list-"));
    try {
      await Promise.all(names.map((name) => mkdir(join(dir, name))));
      expect(await certbotLineageDirs(null, "example.com", dir)).toEqual([
        join(dir, "example.com-0002"),
        join(dir, "example.com-0001"),
        join(dir, "example.com"),
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("remote stores use POSIX paths and do not require the canonical directory to exist", async () => {
    const executor = {
      exec: async () => names.filter((name) => name !== "example.com").join("\n"),
    } as unknown as CommandExecutor;
    expect(await certbotLineageDirs(executor, "example.com")).toEqual([
      "/etc/letsencrypt/live/example.com-0002",
      "/etc/letsencrypt/live/example.com-0001",
    ]);
  });
});
