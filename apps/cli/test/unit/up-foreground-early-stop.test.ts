import { rmSync } from "node:fs";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `openship up --foreground` (what the service runs) stopped while the API is
 * still starting. The API runs in its own process group, so launchd stopping
 * the supervisor never reaches it. The supervisor has to take it down itself,
 * or the API keeps the port and the PGlite lock and the next start fails.
 */

// lib/paths reads OPENSHIP_HOME at import time, so set it before anything loads.
const HOME = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR?.replace(/\/$/, "") || "/tmp"}/openship-up-early-stop-${process.pid}`;
  process.env.OPENSHIP_HOME = dir;
  return dir;
});

const api = vi.hoisted(() => ({ pid: undefined as number | undefined }));

// The API is a real detached process that never becomes healthy, so the
// supervisor is still in its startup wait when the signal arrives.
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  return {
    ...real,
    spawn: (
      _command: string,
      _args: string[],
      options: import("node:child_process").SpawnOptions,
    ) => {
      const child = real.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], options);
      api.pid = child.pid;
      return child;
    },
  };
});
// No staged server bundle under src/; pretend it's there.
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    existsSync: (path: string) =>
      String(path).endsWith("/server/index.js") || real.existsSync(path),
  };
});
// A TTY spinner would add its own signal listeners; keep the test to ours.
vi.mock("ora", () => ({
  default: () => {
    const spinner = {
      text: "",
      start: () => spinner,
      succeed: () => spinner,
      fail: () => spinner,
      warn: () => spinner,
    };
    return spinner;
  },
}));

const { upCommand } = await import("../../src/commands/up");
const { getFreePort } = await import("../../src/lib/ports");

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const SIGNALS = ["SIGINT", "SIGTERM"] as const;
let before: Record<string, Function[]>;
let exit: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  api.pid = undefined;
  before = Object.fromEntries(SIGNALS.map((s) => [s, process.listeners(s)]));
  exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
});

afterEach(() => {
  if (api.pid && alive(api.pid)) process.kill(-api.pid, "SIGKILL");
  for (const s of SIGNALS) {
    for (const l of process.listeners(s)) {
      if (!before[s].includes(l)) process.removeListener(s, l as () => void);
    }
  }
  exit.mockRestore();
});

afterAll(() => rmSync(HOME, { recursive: true, force: true }));

describe("openship up --foreground stopped during startup", () => {
  it("takes the starting API down with it and exits cleanly", async () => {
    const [port, dashboardPort] = [String(await getFreePort()), String(await getFreePort())];
    const args = ["--foreground", "--no-ui", "--port", port, "--dashboard-port", dashboardPort];
    const run = upCommand.parseAsync(args, { from: "user" });

    await vi.waitFor(() => expect(api.pid).toBeDefined(), { timeout: 5000 });
    const pid = api.pid!;
    expect(alive(pid)).toBe(true);

    // What launchd does on `openship stop`, or a re-run replacing the service.
    process.emit("SIGTERM", "SIGTERM");

    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 3000 });
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0), { timeout: 3000 });
    expect(exit).not.toHaveBeenCalledWith(1);
    await run;
  }, 15_000);
});
