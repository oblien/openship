import { describe, expect, it, vi } from "vitest";

import { OS_RELEASE, probeOutput, type ProbeSpec } from "../environment.fixtures";
import type { CommandExecutor } from "../../types";
import type { EdgeStatus, InstallerConfig, SystemLog } from "../types";

/**
 * Privilege for the takeover path that a DEPLOY drives.
 *
 * `runEdgeTakeover` (the dashboard migrate) elevates its own stop; the two-process
 * takeover — `ensureEdgeClear` → `beginEdgeTakeover`, i.e. the installer and every
 * deploy that reconciles the edge — did not. Every command that frees 80/443 is
 * `|| true`-swallowed inside `freeEdgeTargets`, so on a `deploy@host` login the
 * takeover stopped nothing, the ports stayed bound, and the operator was told to go
 * find the other process holding the port: a retry loop that can never succeed as
 * this user.
 *
 * The restore is the same shape with a worse ending. Unelevated, every `systemctl
 * enable --now` / `docker start` in `rollback` is refused, and then the proof reads
 * the foreign proxy that was never stopped and reports `true` — "we put your proxy
 * back" for a box we never touched.
 */
const h = vi.hoisted(() => ({
  probeEdge: vi.fn(),
  freeEdgeTargets: vi.fn(async (_executor: CommandExecutor, ..._rest: unknown[]) => ({
    freed: true,
    stillBound: [] as number[],
  })),
  importSites: vi.fn(async () => ({ proxy: "nginx", sites: [], warnings: [] })),
}));

// Partial: `sq`, `stopTargetsForStatus` and `EDGE_CONTAINER_NAME` pass through, so the
// asserted command strings are the ones production builds.
vi.mock("./detect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./detect")>()),
  probeEdge: h.probeEdge,
  freeEdgeTargets: h.freeEdgeTargets,
}));
// consent.ts reaches the proxy scan through the barrel; mocked to keep the module graph
// off the installer / NginxProvider side of it.
vi.mock("./index", () => ({ importSites: h.importSites }));

import { ensureEdgeClear } from "./consent";
import { beginEdgeTakeover, rollback, JOURNAL_PATH, type TakeoverJournal } from "./takeover-journal";

const ROOT: ProbeSpec = { osRelease: OS_RELEASE.ubuntu2404 };
const NON_ROOT_SUDO: ProbeSpec = {
  osRelease: OS_RELEASE.ubuntu2404,
  uid: "1000",
  user: "deploy",
  home: "/home/deploy",
  sudo: "y",
};
const NON_ROOT_NO_SUDO: ProbeSpec = { ...NON_ROOT_SUDO, sudo: "n" };

const STATUS: EdgeStatus = {
  classification: "known",
  canProceedClean: false,
  occupants: [{ port: 80, systemdUnit: "nginx.service", proxy: "nginx", managedByOpenship: false }],
};
/** A pre-accepted takeover — the non-interactive "Stop it & take over". */
const TAKEOVER: InstallerConfig = { edgePolicy: { mode: "takeover", stopTargets: [] } };

const JOURNAL: TakeoverJournal = {
  startedAt: new Date().toISOString(),
  units: [{ unit: "nginx.service", wasEnabled: true }],
  containers: [{ name: "caddy", restart: "unless-stopped" }],
  processes: [],
};

/** `serving: false` = nothing answers :80 (the box really is dark). */
function host(spec: ProbeSpec, opts: { serving?: boolean } = {}) {
  const commands: string[] = [];
  const executor = {
    exec: vi.fn(async (command: string) => {
      commands.push(command);
      if (command.includes("opsh_begin")) return probeOutput(spec);
      // `portIsServed` — the rollback's proof.
      if (command.includes("ss -ltn")) return opts.serving === false ? "" : "yes";
      return "";
    }),
    streamExec: vi.fn(async () => ({ code: 0, output: "" })),
    writeFile: vi.fn(async (path: string) => {
      commands.push(`writeFile ${path}`);
    }),
    readFile: vi.fn(async () => ""),
    exists: vi.fn(async () => true),
    mkdir: vi.fn(async (path: string) => {
      commands.push(`mkdir ${path}`);
    }),
    rm: vi.fn(async () => {}),
  } as unknown as CommandExecutor;
  return { executor, commands };
}

const elevated = (command: string | undefined) => Boolean(command?.startsWith("sudo -n sh -c "));
const noop = () => {};

describe("beginEdgeTakeover privilege", () => {
  it("elevates the stop that frees 80/443", async () => {
    h.freeEdgeTargets.mockResolvedValue({ freed: true, stillBound: [] });
    const { executor, commands } = host(NON_ROOT_SUDO);

    await beginEdgeTakeover(executor, STATUS, noop);

    const stopExecutor = h.freeEdgeTargets.mock.calls.at(-1)![0];
    await stopExecutor.exec("systemctl disable --now 'nginx.service'");
    expect(elevated(commands.at(-1))).toBe(true);
    expect(commands.at(-1)).toContain("nginx.service");
  });

  // The journal is the ONLY thing that lets the next boot repair a takeover that already
  // stopped someone's proxy, and it lives in root-owned /var/lib/openship — so on a
  // non-root login it was never written at all, silently.
  it("writes the journal into the root-owned dir as root", async () => {
    const { executor, commands } = host(NON_ROOT_SUDO);

    await beginEdgeTakeover(executor, STATUS, noop);

    expect(
      commands.some((c) => elevated(c) && c.includes("mkdir -p") && c.includes("/var/lib/openship")),
    ).toBe(true);
    // Staged as the login user, then published as root — never written straight to the
    // root-owned path, which is what silently failed.
    expect(commands.some((c) => elevated(c) && c.includes("mv -f") && c.includes(JOURNAL_PATH))).toBe(
      true,
    );
    expect(commands).not.toContain(`writeFile ${JOURNAL_PATH}`);
  });

  it("leaves a root login byte-for-byte as it was", async () => {
    const { executor, commands } = host(ROOT);

    await beginEdgeTakeover(executor, STATUS, noop);

    expect(commands.some((c) => c.startsWith("sudo"))).toBe(false);
    expect(commands).toContain(`writeFile ${JOURNAL_PATH}`);
  });
});

describe("rollback privilege", () => {
  it("elevates the restore, and proves the port unelevated", async () => {
    const { executor, commands } = host(NON_ROOT_SUDO);

    expect(await rollback(executor, JOURNAL, noop)).toBe(true);

    expect(elevated(commands.find((c) => c.includes("enable --now") && c.includes("nginx.service")))).toBe(
      true,
    );
    expect(elevated(commands.find((c) => c.includes("docker start")))).toBe(true);
    // The proof is a claim made TO the caller, so it must read what the caller can see.
    expect(commands.find((c) => c.includes("ss -ltn"))?.startsWith("sudo")).toBe(false);
  });

  // `true` here means ":80 is served", which is the fact the caller needs — but on this
  // box it is served because nothing was ever stopped, and reporting it as a successful
  // restore is the one thing worse than reporting the failure.
  it("says the privilege reason instead of quietly claiming a restore", async () => {
    const logs: SystemLog[] = [];
    const { executor, commands } = host(NON_ROOT_NO_SUDO);

    expect(await rollback(executor, JOURNAL, (l) => logs.push(l))).toBe(true);

    expect(commands.some((c) => c.startsWith("sudo"))).toBe(false);
    const said = logs.map((l) => l.message).join("\n");
    expect(said).toMatch(/Restarting the proxy that was holding ports 80\/443/);
    expect(said).toMatch(/passwordless sudo/);
    expect(said).toMatch(/nothing was ever stopped/);
  });
});

describe("ensureEdgeClear privilege", () => {
  it("blames the privilege refusal, not a mystery port holder, when the login can't elevate", async () => {
    h.probeEdge.mockResolvedValue(STATUS);
    h.freeEdgeTargets.mockResolvedValue({ freed: false, stillBound: [80] });
    const { executor } = host(NON_ROOT_NO_SUDO);

    const err = (await ensureEdgeClear(executor, TAKEOVER, noop).catch((e: unknown) => e)) as {
      code?: string;
      message?: string;
    };

    // Same code: the port IS still bound. It's the diagnosis that was wrong.
    expect(err.code).toBe("EDGE_PORTS_STILL_BOUND");
    expect(err.message).toMatch(/port 80 is still in use/);
    expect(err.message).toMatch(/could not run the stop as root/);
    expect(err.message).toMatch(/retrying as this user will fail the same way/i);
    // Neither of the two claims that were untrue on this arm.
    expect(err.message).not.toMatch(/what else is holding the port/i);
    expect(err.message).not.toMatch(/Stopped the existing proxy/);
  });

  // The other arm must keep its advice: on a root login a port that stays bound really
  // does mean something else holds it.
  it("keeps the generic advice when the stop ran as root and the port stayed bound", async () => {
    h.probeEdge.mockResolvedValue(STATUS);
    h.freeEdgeTargets.mockResolvedValue({ freed: false, stillBound: [80, 443] });
    const { executor } = host(ROOT);

    const err = (await ensureEdgeClear(executor, TAKEOVER, noop).catch((e: unknown) => e)) as {
      message?: string;
    };

    expect(err.message).toMatch(/ports 80 and 443 are still in use/);
    expect(err.message).toMatch(/find what else is holding the port and retry/);
    expect(err.message).not.toMatch(/as root/);
  });
});
