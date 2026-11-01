import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { errorReporter, type ErrorEvent } from "@repo/core/diagnostics";

vi.mock("@repo/platform/engine/config/env", () => ({ env: { CLOUD_MODE: false } }));
vi.mock("@repo/platform/engine/lib/cache-store/index", () => ({ cacheStore: async () => ({ get: async () => undefined }) }));
vi.mock("@repo/platform/engine/lib/deployment-runtime", () => ({ resolveServerExecutor: async () => { throw new Error("host unreachable"); } }));
vi.mock("@repo/platform/engine/lib/server-execution", () => ({ withServerExecution: vi.fn() }));

/**
 * The disk probe is the one place in the capacity path that shells out (free
 * space isn't readable over the Docker API). Its safety rests on the command
 * being a CONSTANT: the path it measures is resolved on the host by `docker
 * info`, so no caller-supplied value — `serverId` least of all — ever reaches a
 * shell. Asserted structurally, the same way the host-capacity guard is: a
 * behavioral test would have to mock the whole executor graph and would stop
 * proving anything about the real command string.
 */
const src = readFileSync(
  fileURLToPath(new URL("../../../../packages/platform/src/engine/lib/host-disk.ts", import.meta.url)),
  "utf8",
);

describe("host-disk probe", () => {
  it("builds the command from constants only — no interpolation", () => {
    const start = src.indexOf("const DISK_COMMAND");
    expect(start, "DISK_COMMAND not found").toBeGreaterThan(-1);
    const decl = src.slice(start, src.indexOf(";", src.indexOf("df -Pk", start)));
    // No template literals and no `+ variable` concatenation: every piece is a
    // quoted literal.
    expect(decl).not.toMatch(/`/);
    expect(decl).not.toMatch(/\$\{/);
    expect(decl.split("+").every((part) => /^\s*(const DISK_COMMAND[^=]*=)?\s*['"]/.test(part))).toBe(
      true,
    );
  });

  it("execs exactly one command, and only that constant", () => {
    const execCalls = [...src.matchAll(/\.exec\(([^)]*)\)/g)].map((m) => m[1].trim());
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]).toMatch(/^DISK_COMMAND(?:, \{ timeout: \d+_?\d* \})?$/);
  });

  it("gates on CLOUD_MODE before resolving any executor", () => {
    const fnStart = src.indexOf("export async function getHostDisk");
    expect(fnStart).toBeGreaterThan(-1);
    const guardAt = src.indexOf("env.CLOUD_MODE", fnStart);
    const execAt = src.indexOf("resolveServerExecutor(", fnStart);
    expect(guardAt).toBeGreaterThan(fnStart);
    expect(execAt).toBeGreaterThan(guardAt);
  });

  it("reports an unreachable host while still returning unknown disk capacity", async () => {
    const events: ErrorEvent[] = [];
    await errorReporter.flush();
    errorReporter.setEnabled(true);
    errorReporter.setSink(batch => { events.push(...batch); });
    const { getHostDisk, UNKNOWN_DISK } = await import("@repo/platform/engine/lib/host-disk");
    await expect(getHostDisk("server-a", "org-a")).resolves.toEqual(UNKNOWN_DISK);
    await errorReporter.flush();
    expect(events.some(event => event.error.message === "host unreachable")).toBe(true);
  });
});

it("measures fresh storage through the verified runtime connection without re-resolving its server alias", async () => {
  const { getHostDisk } = await import("@repo/platform/engine/lib/host-disk");
  const exec = vi
    .fn()
    .mockResolvedValueOnce("26214400 1048576")
    .mockResolvedValueOnce("26214400 6291456");
  const executor = { exec } as never;
  expect(await getHostDisk("repointed-alias", "org-a", { executor })).toEqual({
    totalBytes: 25 * 1024 ** 3,
    freeBytes: 1024 ** 3,
  });
  expect(await getHostDisk("repointed-alias", "org-a", { executor })).toEqual({
    totalBytes: 25 * 1024 ** 3,
    freeBytes: 6 * 1024 ** 3,
  });
  expect(exec).toHaveBeenCalledTimes(2);
  for (const [command] of exec.mock.calls)
    expect(command).not.toContain("repointed-alias");
});
