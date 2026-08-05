import { describe, expect, it, vi } from "vitest";

import { ensureAppConfigRoot } from "../../../../src/modules/deployments/compose/deploy.service";
import type { CommandExecutor } from "@repo/adapters";

const DEFAULT_ROOT = "/var/lib/openship/app-config";

function makeExecutor({
  user = "ubuntu",
  initialWritable = false,
  sudoWorks = false,
  mkdirWorks = false,
  writableAfterMkdir = true,
}: {
  user?: string;
  initialWritable?: boolean;
  sudoWorks?: boolean;
  mkdirWorks?: boolean;
  writableAfterMkdir?: boolean;
} = {}): { executor: CommandExecutor; calls: string[] } {
  let writable = initialWritable;
  const calls: string[] = [];
  const exec = vi.fn(async (command: string) => {
    calls.push(command);
    if (command === "id -un") return user;
    if (command.startsWith("test -w")) {
      if (writable) return "";
      throw new Error("test -w: non-zero exit");
    }
    if (command.startsWith("sudo")) {
      if (sudoWorks) {
        writable = true;
        return "";
      }
      throw new Error("sudo: command not found");
    }
    throw new Error(`unexpected exec: ${command}`);
  });
  const mkdir = vi.fn(async (path: string) => {
    calls.push(`mkdir:${path}`);
    if (mkdirWorks) {
      if (writableAfterMkdir) writable = true;
      return;
    }
    throw new Error("EACCES");
  });
  return { executor: { exec, mkdir } as unknown as CommandExecutor, calls };
}

describe("ensureAppConfigRoot", () => {
  it("returns early when the host root is already writable", async () => {
    const { executor, calls } = makeExecutor({ initialWritable: true });
    await ensureAppConfigRoot(executor, DEFAULT_ROOT);
    expect(calls).toEqual(["id -un", `test -w '${DEFAULT_ROOT}'`]);
  });

  it("creates and chowns the root with sudo when missing", async () => {
    const { executor, calls } = makeExecutor({ sudoWorks: true });
    await ensureAppConfigRoot(executor, DEFAULT_ROOT);
    expect(calls).toEqual([
      "id -un",
      `test -w '${DEFAULT_ROOT}'`,
      `sudo mkdir -p '${DEFAULT_ROOT}' && sudo chown -R 'ubuntu' '${DEFAULT_ROOT}'`,
    ]);
  });

  it("falls back to executor mkdir when sudo is unavailable", async () => {
    const { executor, calls } = makeExecutor({ mkdirWorks: true });
    await ensureAppConfigRoot(executor, DEFAULT_ROOT);
    expect(calls).toEqual([
      "id -un",
      `test -w '${DEFAULT_ROOT}'`,
      `sudo mkdir -p '${DEFAULT_ROOT}' && sudo chown -R 'ubuntu' '${DEFAULT_ROOT}'`,
      `mkdir:${DEFAULT_ROOT}`,
      `test -w '${DEFAULT_ROOT}'`,
    ]);
  });

  it("throws a helpful manual instruction when the root cannot be created", async () => {
    const { executor } = makeExecutor();
    await expect(ensureAppConfigRoot(executor, DEFAULT_ROOT)).rejects.toThrow(
      `sudo mkdir -p ${DEFAULT_ROOT}`,
    );
  });

  it("throws when executor mkdir succeeds but the directory is not writable", async () => {
    const { executor } = makeExecutor({ mkdirWorks: true, writableAfterMkdir: false });
    await expect(ensureAppConfigRoot(executor, DEFAULT_ROOT)).rejects.toThrow(
      `sudo chown -R ubuntu ${DEFAULT_ROOT}`,
    );
  });
});
