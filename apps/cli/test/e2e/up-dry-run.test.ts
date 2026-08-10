/**
 * `openship up --dry-run` must change NOTHING (#436).
 *
 * The reported symptom was an unattended Docker install — apt repo, GPG key,
 * ~150 MB of packages and an enabled daemon — on a fresh Debian box whose operator
 * had only asked what `up` would do. The cause was ordering: the install-method
 * decision (which calls `ensureDocker()`) ran BEFORE the dry-run branch.
 *
 * So these tests assert on the absence of side effects, not on wording: every
 * mutating helper is counted and must stay at zero, and the (real) port resolver
 * must not persist ports.json — asserted by pointing OPENSHIP_HOME at a path that
 * doesn't exist and checking it still doesn't afterwards.
 */
import { existsSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted above the imports so lib/paths.ts reads it at module load: every path
// the CLI would write to lands under here, and nothing may create it.
const HOME = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR?.replace(/\/$/, "") || "/tmp"}/openship-dry-run-${process.pid}`;
  process.env.OPENSHIP_HOME = dir;
  return dir;
});

const c = vi.hoisted(() => ({
  /** Mutating helpers — every one of these must stay at 0 during a dry run. */
  ensureDocker: 0,
  prefetch: 0,
  composeUp: 0,
  installAndStart: 0,
  preflight: 0,
  prepareFromSource: 0,
  /** Options the port resolver was called with (persist:false is the contract). */
  portOpts: [] as Array<{ persist?: boolean } | undefined>,
  /** Fixture: Docker is missing but installable (a fresh Debian box). */
  docker: {
    state: { binary: false, plugin: false, daemon: false },
    gap: { summary: "Docker isn't installed", installable: true },
    wouldInstall: true,
    installCommand: "curl -fsSL https://get.docker.com | sh",
    startCommand: "systemctl enable --now docker",
  } as any,
  edge: { owner: null as string | null, blocked: false, sites: [] as any[], warnings: [] as string[] },
}));

vi.mock("../../src/lib/compose", () => ({
  // Read-only previews the plan is built from.
  dockerInstallPreview: () => c.docker,
  composePlan: () => ({
    composeFile: `${HOME}/compose/docker-compose.yml`,
    envFile: `${HOME}/compose/.env`,
    installMethodFile: `${HOME}/install-method`,
    yaml: "services:\n  api:\n    image: ghcr.io/oblien/openship-api:latest\n",
    settings: [{ key: "API_PORT", value: "4000" }],
    newSecrets: ["POSTGRES_PASSWORD", "BETTER_AUTH_SECRET", "INTERNAL_TOKEN"],
    existing: false,
    mountDirs: ["/var/lib/openship/edge/sites-enabled"],
    buildDir: null,
    hostControl: true,
  }),
  resolveComposePorts: async (_p: unknown, opts?: { persist?: boolean }) => {
    c.portOpts.push(opts);
    return {
      api: 4000,
      dashboard: 3001,
      switched: { api: false, dashboard: false },
      preferred: { api: 4000, dashboard: 3001 },
    };
  },
  // Mutating: none of these may run.
  ensureDocker: async () => {
    c.ensureDocker++;
    return true;
  },
  composePrefetch: () => {
    c.prefetch++;
    return true;
  },
  composeUp: async () => {
    c.composeUp++;
    return { ok: true, apiPort: "4000", dashPort: "3001" };
  },
  hasDockerCompose: () => true,
  composeTrustedOriginUrls: () => [],
  composeInternalToken: () => "tok",
  sourceBuildDir: () => null,
}));

// Partial: `preview` is pinned to a systemd box (the test host is macOS) and the
// installer is counted, but `installStepFor` stays REAL so the plan is asserted
// against the wording that ships.
vi.mock("../../src/lib/service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/service")>()),
  preview: () => ({
    kind: "systemd-user",
    path: `${HOME}/openship.service`,
    content: "[Service]\nExecStart=/usr/bin/node index.js up --foreground\n",
  }),
  installAndStart: () => {
    c.installAndStart++;
    return { kind: "systemd-user", detail: "installed" };
  },
}));

vi.mock("../../src/lib/edge-preflight", () => ({
  previewHostEdge: async () => c.edge,
  planAndApplyHostEdge: async () => {
    c.preflight++;
    return { proceed: true };
  },
  rollbackHostEdge: async () => false,
  completeHostEdge: async () => {},
  markStoppedProxyImported: () => {},
}));

vi.mock("../../src/lib/from-source", () => ({
  // The dirs the plan names come from this module (one definition, see up-plan).
  DEFAULT_REPO: "https://github.com/oblien/openship.git",
  SOURCE_CHECKOUT_DIR: `${HOME}/src`,
  SOURCE_DIST_DIR: `${HOME}/from-source-dist`,
  prepareFromSource: async () => {
    c.prepareFromSource++;
    return { apiDir: "/tmp/api", dashboardDir: "/tmp/dash", ref: "main", sha: "abc1234", sourceDir: "/tmp/src" };
  },
}));

import { upCommand } from "../../src/commands/up";
import { runCommand } from "../helpers/harness";

const realPlatform = process.platform;
function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

function captureConsole() {
  let buf = "";
  const sink = (...a: unknown[]) => {
    buf += a.map(String).join(" ") + "\n";
  };
  const log = vi.spyOn(console, "log").mockImplementation(sink);
  const error = vi.spyOn(console, "error").mockImplementation(sink);
  return {
    text: () => buf.replace(/\[[0-9;]*m/g, ""),
    restore: () => {
      log.mockRestore();
      error.mockRestore();
    },
  };
}

let con: ReturnType<typeof captureConsole>;

/** Nothing was created, started, downloaded or installed. */
function expectNoSideEffects() {
  expect(c.ensureDocker).toBe(0);
  expect(c.prefetch).toBe(0);
  expect(c.composeUp).toBe(0);
  expect(c.installAndStart).toBe(0);
  expect(c.preflight).toBe(0);
  expect(c.prepareFromSource).toBe(0);
  expect(existsSync(HOME)).toBe(false);
}

beforeEach(() => {
  c.ensureDocker = 0;
  c.prefetch = 0;
  c.composeUp = 0;
  c.installAndStart = 0;
  c.preflight = 0;
  c.prepareFromSource = 0;
  c.portOpts = [];
  c.edge = { owner: null, blocked: false, sites: [], warnings: [] };
  for (const flag of ["compose", "bare", "foreground", "fromSource", "source", "port", "dashboardPort"]) {
    (upCommand as any).setOptionValue?.(flag, undefined);
  }
  rmSync(HOME, { recursive: true, force: true });
  setPlatform("linux");
  con = captureConsole();
});

afterEach(() => {
  con.restore();
  setPlatform(realPlatform);
  rmSync(HOME, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("openship up --dry-run", () => {
  // The issue verbatim: fresh Debian, no Docker, plain `up --dry-run`.
  it("does NOT install Docker to work out that it would install Docker", async () => {
    const r = await runCommand(upCommand, ["--dry-run"]);
    expect(r.code).toBe(0);
    expectNoSideEffects();

    const out = con.text();
    expect(out).toContain("nothing on this machine has been changed");
    // …and it says so instead, with the command it would have run.
    expect(out).toContain("Docker isn't installed");
    expect(out).toContain("curl -fsSL https://get.docker.com | sh");
  });

  it("describes the compose stack without writing or pulling it", async () => {
    const r = await runCommand(upCommand, ["--dry-run", "--compose"]);
    expect(r.code).toBe(0);
    expectNoSideEffects();

    const out = con.text();
    expect(out).toContain(`${HOME}/compose/docker-compose.yml`);
    expect(out).toContain("POSTGRES_PASSWORD");
    expect(out).toContain("docker compose pull");
    expect(out).toContain("docker compose up -d");
    // The compose file itself, as it would be written.
    expect(out).toContain("ghcr.io/oblien/openship-api:latest");
  });

  it("resolves ports WITHOUT persisting them", async () => {
    // ports.json is what `status`/`doctor`/the control panel read to find the
    // running instance — a preview that rewrote it would point them at a port
    // nothing is listening on.
    await runCommand(upCommand, ["--dry-run", "--compose"]);
    expect(c.portOpts).toEqual([{ persist: false }]);
    expect(existsSync(`${HOME}/ports.json`)).toBe(false);
  });

  it("reports a foreign proxy on :80/:443 without stopping it", async () => {
    c.edge = {
      owner: "nginx.service",
      blocked: true,
      sites: [{ serverNames: ["shop.example.com"], ssl: true, target: { kind: "proxy", url: "http://127.0.0.1:3000" } }],
      warnings: [],
    };

    await runCommand(upCommand, ["--dry-run", "--compose"]);

    expect(c.preflight).toBe(0); // the flow that journals + stops it never ran
    const out = con.text();
    expect(out).toContain("nginx.service");
    expect(out).toContain("shop.example.com");
    expect(out).toMatch(/migrate/i);
  });

  // The documented behaviour that must survive the fix.
  it("still prints the service definition for --bare, and installs nothing", async () => {
    const r = await runCommand(upCommand, ["--dry-run", "--bare"]);
    expect(r.code).toBe(0);
    expectNoSideEffects();

    const out = con.text();
    expect(out).toContain(`${HOME}/openship.service`);
    expect(out).toContain("ExecStart=/usr/bin/node index.js up --foreground");
    expect(out).toContain("systemctl --user enable --now");
    // The bare install's own writes are named rather than made.
    expect(out).toContain(`${HOME}/data/`);
  });

  it("previews --foreground instead of starting it attached", async () => {
    const r = await runCommand(upCommand, ["--dry-run", "--foreground"]);
    expect(r.code).toBe(0);
    expectNoSideEffects();
    expect(con.text()).toContain("Run attached in this terminal");
  });

  it("previews --from-source instead of cloning and building it", async () => {
    const r = await runCommand(upCommand, ["--dry-run", "--from-source", "--ref", "test-2"]);
    expect(r.code).toBe(0);
    expectNoSideEffects();

    const out = con.text();
    expect(out).toContain("Build from source");
    expect(out).toMatch(/git clone\/fetch/);
    expect(out).toContain("test-2");
  });
});
