import { describe, it, expect } from "vitest";
import { runBuildPipeline, BuildLogger, type BuildEnvironment } from "./build-pipeline";
import type { BuildConfig } from "../types";

/**
 * openship#623 on the pipeline surface: a detected command that names a
 * DEPENDENCY binary (`next build`, `vite build`, `tsc`) is handed to a bare
 * `sh -c`, which — unlike `npm run` — does NOT prepend `node_modules/.bin`.
 * The fix is a `nodeBinPathExport` prelude chained onto the install and build
 * commands. This suite is the pipeline's only coverage of it.
 *
 * A REAL BuildLogger (no callback) is used rather than a cast fake: the pipeline
 * drives every step through `runStep`, so the class's own control flow is part of
 * what's under test.
 */

const PROJECT_DIR = "/tmp/openship/proj-1";

/** Records every command the pipeline executes, in order. */
function recordingEnv(commands: string[], over: Partial<BuildEnvironment> = {}): BuildEnvironment {
  return {
    projectDir: PROJECT_DIR,
    exec: async (command) => {
      commands.push(command);
    },
    ...over,
  };
}

/**
 * `sourceStaged` skips the clone step so the recorded array is exactly the
 * install and build commands — which is what makes the "no separate exec"
 * assertion below meaningful. The pipeline reads nothing else off the config
 * beyond the fields set here (`resources` is read only when `hasNativeEnv`).
 */
function makeConfig(over: Partial<BuildConfig> = {}): BuildConfig {
  return {
    sourceStaged: true,
    envVars: {},
    packageManager: "npm",
    installCommand: "npm ci",
    buildCommand: "next build",
    ...over,
  } as unknown as BuildConfig;
}

describe("runBuildPipeline node_modules/.bin PATH prelude (#623)", () => {
  // Nearest-first: a monorepo hoists dependencies to the workspace root, so the
  // sub-app dir alone is not enough — both roots must be on PATH, shell-quoted.
  const EXPECTED_EXPORT =
    `export PATH='${PROJECT_DIR}/apps/web/node_modules/.bin':` +
    `'${PROJECT_DIR}/node_modules/.bin':"$PATH"`;

  it("carries the export on BOTH the install and the build command", async () => {
    const commands: string[] = [];

    const res = await runBuildPipeline(
      recordingEnv(commands),
      makeConfig({ rootDirectory: "apps/web" }),
      new BuildLogger(),
    );

    expect(res.status).toBe("deploying");
    expect(commands).toHaveLength(2);
    // Install matters as much as build: an install command can name a dependency
    // binary too (a `postinstall`-style prep, `prisma generate`).
    for (const command of commands) {
      expect(command).toContain(EXPECTED_EXPORT);
    }
    expect(commands[0]).toContain("npm ci");
    expect(commands[1]).toContain("next build");
  });

  it("puts the build dir ahead of the repo root, and both ahead of the inherited PATH", async () => {
    const commands: string[] = [];

    await runBuildPipeline(
      recordingEnv(commands),
      makeConfig({ rootDirectory: "apps/web" }),
      new BuildLogger(),
    );

    const buildCmd = commands[1]!;
    const buildBin = buildCmd.indexOf(`'${PROJECT_DIR}/apps/web/node_modules/.bin'`);
    const rootBin = buildCmd.indexOf(`'${PROJECT_DIR}/node_modules/.bin'`);
    const inherited = buildCmd.indexOf(`:"$PATH"`);

    expect(buildBin).toBeGreaterThan(-1);
    expect(rootBin).toBeGreaterThan(buildBin);
    expect(inherited).toBeGreaterThan(rootBin);
  });

  // Go/Rust/PHP have no node_modules/.bin, so the entries would be dead weight on
  // every command lookup — and a bogus PATH entry in a language whose toolchain
  // resolves differently is worse than useless.
  it.each(["go", "composer"])("emits NO PATH text at all for packageManager=%s", async (pm) => {
    const commands: string[] = [];

    const res = await runBuildPipeline(
      recordingEnv(commands),
      makeConfig({
        packageManager: pm,
        rootDirectory: "apps/web",
        installCommand: "go mod download",
        buildCommand: "go build ./...",
      }),
      new BuildLogger(),
    );

    expect(res.status).toBe("deploying");
    expect(commands).toHaveLength(2);
    for (const command of commands) {
      expect(command).not.toContain("PATH");
      expect(command).not.toContain("node_modules/.bin");
    }
  });

  /**
   * The invariant that actually protects the fix: `export` mutates only the shell
   * that runs it, so the prelude has to ride in the SAME command string as the
   * build. Emitted as its own `exec`, it would be a separate process whose
   * environment the build never inherits — a green pipeline and exit 127 anyway.
   *
   * Deliberately NOT asserted: that the export precedes the `cd`. Either order
   * resolves (PATH entries are looked up per invocation, and a later `cd sub`
   * doesn't unset them), so pinning it would fail a legitimate refactor.
   */
  it("chains the export into the build command itself — never a standalone exec", async () => {
    const commands: string[] = [];

    await runBuildPipeline(
      recordingEnv(commands),
      makeConfig({ rootDirectory: "apps/web", installCommand: "" }),
      new BuildLogger(),
    );

    // Install skipped → the build is the ONLY exec, so there is no earlier
    // command a stray export could have been parked in.
    expect(commands).toHaveLength(1);
    const buildCmd = commands[0]!;
    expect(buildCmd).toContain(EXPECTED_EXPORT);
    expect(buildCmd).toContain("next build");
    expect(buildCmd.indexOf(EXPECTED_EXPORT)).toBeLessThan(buildCmd.indexOf("next build"));
  });
});
