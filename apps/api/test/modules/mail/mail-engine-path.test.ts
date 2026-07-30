import "./_setup-env";
import { afterEach, describe, expect, test, vi } from "vitest";

/**
 * Step 7 tars the engine tree off the API host, so the path has to survive both
 * start-up layouts: `bun dev` from apps/api, and the container's CMD from /app.
 * The container case previously resolved to `/apps/email/engine` — off the
 * filesystem root — and the step died with "tar: ... Cannot open".
 */
const mocks = vi.hoisted(() => ({ existsSync: vi.fn() }));

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: mocks.existsSync,
}));

import { resolveLocalEngineDir } from "../../../src/modules/mail/mail.service";

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  delete process.env.MAIL_SERVER_ENGINE_DIR;
});

/** Pretend the process started in `cwd`, with `engine` the only tree on disk. */
function atCwd(cwd: string, engine: string) {
  vi.spyOn(process, "cwd").mockReturnValue(cwd);
  mocks.existsSync.mockImplementation((p: unknown) => p === engine);
}

describe("resolveLocalEngineDir", () => {
  test("finds the engine from the repo layout (cwd = apps/api)", () => {
    atCwd("/repo/apps/api", "/repo/apps/email/engine");
    expect(resolveLocalEngineDir()).toBe("/repo/apps/email/engine");
  });

  test("finds the engine from the container layout (cwd = /app)", () => {
    atCwd("/app", "/app/apps/email/engine");
    expect(resolveLocalEngineDir()).toBe("/app/apps/email/engine");
  });

  test("never resolves off the filesystem root", () => {
    atCwd("/app", "/app/apps/email/engine");
    expect(resolveLocalEngineDir()).not.toBe("/apps/email/engine");
  });

  test("MAIL_SERVER_ENGINE_DIR wins without touching the filesystem", () => {
    atCwd("/app", "/app/apps/email/engine");
    process.env.MAIL_SERVER_ENGINE_DIR = "/opt/openship/engine";
    expect(resolveLocalEngineDir()).toBe("/opt/openship/engine");
    expect(mocks.existsSync).not.toHaveBeenCalled();
  });

  test("falls back to the repo path when the engine is missing entirely", () => {
    vi.spyOn(process, "cwd").mockReturnValue("/repo/apps/api");
    mocks.existsSync.mockReturnValue(false);
    expect(resolveLocalEngineDir()).toBe("/repo/apps/email/engine");
  });
});
