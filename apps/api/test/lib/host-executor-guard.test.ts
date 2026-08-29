import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Host-control paths must run through the HOST channel — LocalExecutor when bare,
 * SSH→host.docker.internal when containerized (OPENSHIP_HOST_SSH_*). A no-arg
 * createExecutor() is ALWAYS LocalExecutor, which in Docker-deployed mode silently
 * probes the api container's own netns instead of the host (the "single switchable
 * executor" fix). This guards against regressing to it.
 *
 * TWO spellings are accepted, and the pooled one is preferred:
 *   • `sshManager.withHostExecutor(fn)` — the pooled channel. Use this.
 *   • `createHostExecutor()` — the raw factory. Every call builds a NEW SSH
 *     connection to the host, so an un-disposed one leaks an sshd session (#291);
 *     only the manager should call it now.
 *
 * self-edge.ts is intentionally excluded: it early-returns in docker-edge mode
 * and its createExecutor() only runs bare, where local IS the host.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const HOST_CONTROL_FILES = [
  "../../src/lib/startup/self-deploy.ts",
  "../../src/modules/system/self-app.controller.ts",
];

describe("host-control executor guard", () => {
  for (const rel of HOST_CONTROL_FILES) {
    it(`${rel} targets the host channel, not a no-arg createExecutor()`, () => {
      const src = read(rel);
      const noArg = [...src.matchAll(/\bcreateExecutor\(\s*\)/g)];
      expect(noArg.length, "no-arg createExecutor() found — use withHostExecutor()").toBe(0);
      const usesHostChannel =
        src.includes("withHostExecutor") || src.includes("createHostExecutor");
      expect(usesHostChannel, "no host-channel accessor found in a host-control file").toBe(true);
    });
  }
});

/**
 * `createHostExecutor()` has exactly ONE owner: `ssh-manager.ts`, from inside the pool.
 *
 * The docstring above already says only the manager should call it. This makes that
 * mechanical, because the rule had been broken again from the one door that holds no
 * server row: `deployment-runtime`'s derived-`local` branch called the factory
 * directly, landing outside the cache, outside the concurrent-acquire dedup and
 * outside `assertHostChannelUsable` — the unpooled idiom #291 blames for 8,000+
 * orphaned sshd sessions, on the single path that had nothing to launder through
 * `acquire`. `sshManager.acquireHostChannel()` is the answer for a caller with no row.
 *
 * Both halves are asserted, so the rule cannot rot in either direction: nobody else
 * calls it, and the owner still does (a rule whose owner stopped matching is a rule
 * that has quietly stopped guarding anything).
 */
describe("createHostExecutor has one owner", () => {
  const OWNER = "src/lib/ssh-manager.ts";

  it(`only ${OWNER} constructs the host executor`, () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const files = execFileSync("git", ["ls-files", "--", "src"], { cwd: root, encoding: "utf8" })
      .split("\n")
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    expect(files.length, "no sources listed — the glob or cwd is wrong").toBeGreaterThan(100);

    const callers = files.filter((f) =>
      /\bcreateHostExecutor\(\s*\)/.test(code(readFileSync(`${root}${f}`, "utf8"))),
    );
    expect(callers.sort()).toEqual([OWNER]);
  });
});

/**
 * Resolving a deploy target READS this box's server row; it never registers one.
 *
 * `ensureLocalServer` creates the row, and its creation path detects the box's public
 * IP — an outbound request. On a resolve that also runs for plain runtime reads, that
 * makes a deploy responsible for registering a server and pays a network call per
 * resolve on any box whose row is missing. `findLocalServer` shares its gates, so
 * there is still one definition of "this box's row"; only the write moved out.
 *
 * Pinned textually as well as behaviourally (`derived-local-target.test.ts`) because
 * the behavioural test can only speak for the resolve paths that exist today.
 */
describe("target resolution never registers this box", () => {
  it("deployment-runtime.ts reads the row, it does not ensure it", () => {
    const src = code(read("../../src/lib/deployment-runtime.ts"));
    expect(src).toContain("findLocalServer(");
    expect(src, "ensureLocalServer() on a resolve path — use findLocalServer()").not.toContain(
      "ensureLocalServer(",
    );
  });
});

/**
 * BOTH deploy pipelines must announce a demoted host channel, once, before the first
 * thing that quietly needs it (#509).
 *
 * A source-level guard because the alternative is driving two whole pipelines to assert
 * an ordering; `compose-host-channel-notice.test.ts` does that behaviourally for the
 * compose one. What this pins is the shape the bug had: the port scan's own hint existed
 * but sat INSIDE the `routeStrategy === "loopback-port"` branch, so on every other
 * routing strategy the operator's first legible symptom was a container that died later
 * over a config file that never landed. Comments are stripped first — the reasoning below
 * the call site names `loopback-port`, and matching that would pass for the wrong reason.
 */
const PIPELINES = [
  {
    file: "../../src/modules/deployments/build-pipeline.ts",
    executionScope: "async function executeBuildAndDeploy",
  },
  {
    file: "../../src/modules/deployments/compose/deploy.service.ts",
    executionScope: "async function deployComposeServicesUnlocked",
  },
];

/** Drop block and line comments so an index comparison reads CODE positions. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

describe("both deploy pipelines announce a demoted host channel", () => {
  for (const { file, executionScope } of PIPELINES) {
    it(`${file} emits the notice before any host touchpoint, on every route strategy`, () => {
      const fileSource = code(read(file));
      const scope = fileSource.indexOf(executionScope);
      expect(scope, `${executionScope} is missing`).toBeGreaterThan(-1);
      // Scope the ordering check to the function that actually performs the
      // deployment. The Compose public wrapper may inspect routeStrategy to choose
      // the target-wide allocation lock, but it performs no host operation; the
      // unlocked implementation remains the one place that fans out to them.
      const src = fileSource.slice(scope);
      const notice = src.indexOf("hostChannelDeployNotice(");
      expect(notice, "hostChannelDeployNotice() is never called").toBeGreaterThan(-1);
      // Before the port allocation and the routing preflight, whose own hints are the
      // ones that absorbed the refusal silently.
      for (const touchpoint of ["allocateHostPort(", "ensureRoutingReady("]) {
        const at = src.indexOf(touchpoint);
        if (at === -1) continue;
        expect(notice, `notice must precede ${touchpoint}`).toBeLessThan(at);
      }
      // And ahead of the first mention of routeStrategy, so it cannot have been nested
      // inside a strategy branch.
      const strategy = src.indexOf("routeStrategy");
      if (strategy !== -1) {
        expect(notice, "notice must not sit inside a routeStrategy branch").toBeLessThan(strategy);
      }
      // Never fatal: a warn line, not a throw.
      expect(src.slice(notice, notice + 400)).toContain('"warn"');
    });
  }
});
