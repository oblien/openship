/**
 * openship#623 on the BARE start surface.
 *
 * The registry's start defaults for nextjs / remix / gatsby are bare dependency
 * binaries (`next start`, `remix-serve`, `gatsby serve`), and both supervisors
 * hand the start command to a `sh -lc` — systemd as
 * `ExecStart=/bin/sh -lc <quoted>`, nohup inside its own `nohup sh -lc <quoted>`.
 * Neither prepends `node_modules/.bin` the way `npm run` does, so the binary is
 * unresolvable at boot even though it sits right there in the release dir: exit
 * 127, the same failure that was fixed on the two BUILD paths and reached no
 * start path outside docker.
 *
 * The fix is a SHELL PRELUDE rather than a supervisor env var, and that choice is
 * the invariant worth pinning: systemd `Environment=` does no `$PATH` expansion,
 * so `Environment=PATH=…` would REPLACE the system PATH rather than extend it and
 * the app would lose /usr/bin — node included — on the way to finding `next`.
 *
 * Two INDEPENDENT mechanisms come out of that, and this file pins both:
 *
 *   1. the prelude is on the start command (first describe below), and
 *   2. a PATH the PROJECT set is stripped from the supervisor env (second
 *      describe) — because the transport that carries it does no expansion
 *      either, so it lands as the base the prelude in (1) prepends to. The
 *      dependency binary would still resolve; the interpreter behind its shebang
 *      (`#!/usr/bin/env node`) would not.
 */

import { describe, expect, it } from "vitest";

import { BareRuntime } from "../src/runtime/bare";
import { droppedRuntimeEnvMessage } from "../src/runtime/runtime-env";
import type { CommandExecutor, DeployConfig, LogEntry } from "../src/types";
import type { ProcessSupervisor, SupervisorDeployOpts } from "../src/runtime/supervisor/types";

const WORK_DIR = "/opt/openship";
const PROJECT_ID = "prj_web";
/** With no `imageRef` there is nothing to promote, so the release dir the
 *  supervisor is given is the project dir verbatim — and it is the root the
 *  prelude must point at. */
const RELEASE_DIR = `${WORK_DIR}/${PROJECT_ID}`;

/**
 * An executor that fails loudly on any call.
 *
 * The deploy under test must reach the supervisor without dialling the host at
 * all: no `imageRef` means no artifact promote, and no volumes means
 * `linkPersistentPaths` returns before its first `exists()`. A throw here means
 * the test is exercising something other than the composition it claims to.
 */
const NO_HOST = new Proxy(
  {},
  {
    get(_target, prop) {
      if (typeof prop === "symbol") return undefined;
      return () => {
        throw new Error(`bare deploy touched the host: ${String(prop)}()`);
      };
    },
  },
) as unknown as CommandExecutor;

/**
 * Drive `BareRuntime.deploy` and return exactly what it handed the supervisor,
 * plus every log entry it emitted.
 *
 * `deploy` resolves its supervisor lazily and caches it in `_supervisor`, so
 * seeding that cache is the whole seam — no production code is restructured for
 * this. Letting the real `detectSupervisor` run instead would probe the host's
 * init system and then execute nohup's spawn plus its 1.5s liveness wait, which
 * would test systemd/nohup quoting rather than the one thing this file is about:
 * the exact string and env `deploy` composes.
 *
 * `logs` is a COMPLETE transcript, not a filtered one: with `volumes: []` the only
 * other `_onLog` caller on this path (`linkPersistentPaths`) returns before it can
 * say anything, so `logs.length` is an exact assertion rather than a floor.
 */
async function captureDeploy(
  over: Partial<DeployConfig> = {},
): Promise<{ opts: SupervisorDeployOpts; logs: LogEntry[] }> {
  const runtime = new BareRuntime({ workDir: WORK_DIR, executor: NO_HOST });
  const calls: SupervisorDeployOpts[] = [];
  const logs: LogEntry[] = [];
  const supervisor = {
    name: "recording",
    deploy: async (opts: SupervisorDeployOpts) => {
      calls.push(opts);
    },
  } as unknown as ProcessSupervisor;
  (runtime as unknown as { _supervisor: ProcessSupervisor })._supervisor = supervisor;

  await runtime.deploy(
    {
      deploymentId: "dep_1",
      projectId: PROJECT_ID,
      buildSessionId: "sess_1",
      environment: "production",
      port: 3000,
      envVars: {},
      volumes: [],
      startCommand: "next start",
      ...over,
    } as unknown as DeployConfig,
    (entry) => logs.push(entry),
  );

  expect(calls).toHaveLength(1);
  return { opts: calls[0]!, logs };
}

async function startCommand(over: Partial<DeployConfig> = {}): Promise<string> {
  return (await captureDeploy(over)).opts.startCommand;
}

const PRELUDE = `export PATH='${RELEASE_DIR}/node_modules/.bin':"$PATH"`;

describe("BareRuntime.deploy — node_modules/.bin on the start command's PATH (#623)", () => {
  it("prefixes the start command for every node package manager", async () => {
    for (const packageManager of ["npm", "yarn", "pnpm", "bun"]) {
      expect(await startCommand({ packageManager }), packageManager).toBe(
        `${PRELUDE} && next start`,
      );
    }
  });

  it("only prepends — the original command survives verbatim at the tail", async () => {
    const cmd = await startCommand({
      packageManager: "bun",
      startCommand: 'next start -p "$PORT" --hostname 0.0.0.0',
    });
    expect(cmd.startsWith("export PATH=")).toBe(true);
    expect(cmd).toContain(`${RELEASE_DIR}/node_modules/.bin`);
    expect(cmd.endsWith(' && next start -p "$PORT" --hostname 0.0.0.0')).toBe(true);
    // `"$PATH"` stays double-quoted so the login shell expands it: the prelude
    // EXTENDS the inherited PATH. Dropping that tail is the same class of bug as
    // using a supervisor env var — the app finds `next` and loses `node`.
    expect(cmd).toContain(':"$PATH"');
  });

  it("is byte-identical to the raw command for a non-node PM and for none at all", async () => {
    for (const packageManager of ["go", "pip", "cargo", "composer", undefined]) {
      const label = String(packageManager);
      const cmd = await startCommand({ packageManager });
      // Not "does not contain the prelude" — exactly the input. Go/Rust/Python
      // have no node_modules/.bin, so there must be no prelude AND no dangling
      // `&&` from composing one onto an empty string.
      expect(cmd, label).toBe("next start");
      expect(cmd, label).not.toContain("&&");
      expect(cmd, label).not.toContain("export");
    }
  });

  it("applies the `npm start` default before the prelude, not after", async () => {
    expect(await startCommand({ packageManager: "npm", startCommand: undefined })).toBe(
      `${PRELUDE} && npm start`,
    );
    // The fallback is `||`, not `??`, so a blank start command takes the same
    // branch — a prelude chained onto nothing would exit 127 on the empty word.
    expect(await startCommand({ packageManager: "npm", startCommand: "" })).toBe(
      `${PRELUDE} && npm start`,
    );
    expect(await startCommand({ packageManager: "go", startCommand: "" })).toBe("npm start");
  });

  it("invents no PATH of its own — the prelude is the only place it appears", async () => {
    // The fixture deliberately sets NO project PATH, so this covers exactly one
    // half of the guarantee: BareRuntime never ADDS a PATH env var while routing
    // the dirs through the shell prelude instead. The other half — STRIPPING a
    // PATH the project set — is the second describe block, and needs a fixture
    // that actually supplies one.
    const { opts } = await captureDeploy({ packageManager: "bun" });
    expect(Object.keys(opts.env)).not.toContain("PATH");
    // PORT/NODE_ENV are what the supervisor env is for, so the assertion above
    // is about PATH specifically and not about an env that failed to populate.
    expect(opts.env.PORT).toBe("3000");
    expect(opts.env.NODE_ENV).toBe("production");
  });

  it("roots the prelude at the same dir it tells the supervisor to cd into", async () => {
    // The two are derived from one `workDir` local; if they ever drift, PATH
    // points at a node_modules the process cannot see from its own cwd.
    const { opts } = await captureDeploy({ packageManager: "pnpm" });
    expect(opts.workDir).toBe(RELEASE_DIR);
    expect(opts.startCommand).toContain(`${opts.workDir}/node_modules/.bin`);
  });
});

/**
 * A project env var named PATH must never reach the supervisor env (#623).
 *
 * Worse here than on docker, not better. Both transports the supervisors use
 * REPLACE rather than extend: systemd emits `Environment="PATH=…"` and does no
 * `$PATH` expansion, and nohup emits `export PATH=…;` AHEAD of the start command
 * — which makes the project's value the base the prelude above prepends to. So
 * before this filter the app would find `next` and then fail on its shebang
 * interpreter, with a green build log and nothing naming PATH.
 *
 * Pinned on the OPTS the supervisor was handed, for the reason
 * docker-runtime-env-path.test.ts gives: the filter being correct says nothing
 * about a site that forgot to call it.
 */

/** Insertion-ordered on purpose, and near-misses included: the filter is an
 *  exact-key match, not a substring one, and POSIX env is case-sensitive so
 *  lowercase `path` is a distinct variable no loader reads for lookup. */
const PROJECT_ENV: Record<string, string> = {
  APP_NAME: "demo",
  // The poison. An absolute literal with no `$PATH` to inherit from.
  PATH: "/usr/local/bin:/usr/bin",
  MY_PATH: "/opt/mine",
  PATHOLOGY: "chronic",
  path: "/lower/case",
  NODE_OPTIONS: "--max-old-space-size=512",
};

/** PROJECT_ENV minus PATH, plus the two the runtime injects itself. Asserted
 *  whole with `toEqual` so this fails both ways: a lost filter re-adds PATH, and
 *  an over-broad one deletes operator data. */
const EXPECTED_ENV: Record<string, string> = {
  APP_NAME: "demo",
  MY_PATH: "/opt/mine",
  PATHOLOGY: "chronic",
  path: "/lower/case",
  NODE_OPTIONS: "--max-old-space-size=512",
  PORT: "3000",
  NODE_ENV: "production",
};

describe("BareRuntime.deploy — a project PATH never reaches the supervisor env (#623)", () => {
  it("strips PATH and hands every other project var through with its value intact", async () => {
    const { opts } = await captureDeploy({ packageManager: "bun", envVars: PROJECT_ENV });
    expect(opts.env).toEqual(EXPECTED_ENV);
  });

  it("warns exactly once, naming the key it ignored", async () => {
    const { logs } = await captureDeploy({ packageManager: "bun", envVars: PROJECT_ENV });
    // Exact count: the operator typed this key by hand, and a silent drop is how
    // they end up debugging a 127 with no explanation anywhere in the product.
    expect(logs).toHaveLength(1);
    expect(logs[0]!.level).toBe("warn");
    // Two assertions on one string on purpose. `toBe` pins what the site passed
    // to the message builder (only PATH — not every project key); `toContain`
    // pins the operator-facing requirement that the key is actually named, which
    // would survive a rewording of the shared message.
    expect(logs[0]!.message).toBe(droppedRuntimeEnvMessage(["PATH"]));
    expect(logs[0]!.message).toContain("PATH");
  });

  it("says nothing when the project set no PATH", async () => {
    const { opts, logs } = await captureDeploy({
      packageManager: "bun",
      envVars: { APP_NAME: "demo", MY_PATH: "/opt/mine" },
    });
    expect(logs).toEqual([]);
    expect(opts.env).toEqual({
      APP_NAME: "demo",
      MY_PATH: "/opt/mine",
      PORT: "3000",
      NODE_ENV: "production",
    });
  });

  it("still applies the #623 prelude to the start command", async () => {
    // The interaction that matters: the two mechanisms are independent, and
    // before the env filter the project's PATH was precisely the base this
    // prelude's `:"$PATH"` tail expanded to. Both must hold at once.
    const { opts } = await captureDeploy({ packageManager: "bun", envVars: PROJECT_ENV });
    expect(opts.startCommand).toBe(`${PRELUDE} && next start`);
    expect(opts.env.PATH).toBeUndefined();
  });

  it("filters even when there is no prelude to protect", async () => {
    // A Go project has no node_modules/.bin, so nothing was added for the
    // project's PATH to overwrite — but replacing the system PATH still costs the
    // process /usr/bin. The filter is not gated on the prelude existing.
    const { opts, logs } = await captureDeploy({ packageManager: "go", envVars: PROJECT_ENV });
    expect(opts.startCommand).toBe("next start");
    expect(opts.env).toEqual(EXPECTED_ENV);
    expect(logs).toHaveLength(1);
  });

  it("a project whose ONLY var is PATH contributes nothing but the warning", async () => {
    const { opts, logs } = await captureDeploy({
      packageManager: "bun",
      envVars: { PATH: "/usr/bin" },
    });
    expect(opts.env).toEqual({ PORT: "3000", NODE_ENV: "production" });
    expect(logs).toHaveLength(1);
  });
});
