import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redisSentinelReadiness } from "./redis-readiness";

describe("Redis failover readiness", () => {
  let directory: string;
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "redis-readiness-"));
    // Execute the actual POSIX-shell check, including its parsing and exit
    // status, against protocol replies from three independently addressed voters.
    writeFileSync(join(directory, "timeout"), '#!/bin/sh\nshift\nexec "$@"\n', { mode: 0o700 });
    writeFileSync(
      join(directory, "redis-cli"),
      `#!/bin/sh
case "$*" in
  *'INFO server'*) printf 'run_id:%s\\r\\n' "$PRIMARY_ID"; exit 0 ;;
esac
case "$*" in
  *database-sentinel-2.*) affected=yes ;;
  *) affected=no ;;
esac
voters=3; replicas=3; flags=master; runid="$PRIMARY_ID"
if [ "$affected" = yes ]; then
  case "$SCENARIO" in
    unavailable) exit 1 ;;
    partial-quorum) voters=2 ;;
    forgotten-replicas) replicas=0 ;;
    missing-replica) replicas=2 ;;
    stale-replicas) replicas=4 ;;
    disconnected) flags=master,disconnected ;;
    stale-primary) runid=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb ;;
  esac
fi
case "$*" in
  *CKQUORUM*) printf 'OK %s usable Sentinels. Quorum and failover authorization can be reached\\n' "$voters" ;;
  *MASTER*) printf 'flags\\r\\n%s\\r\\nrunid\\r\\n%s\\r\\nnum-slaves\\r\\n%s\\r\\nnum-other-sentinels\\r\\n2\\r\\n' "$flags" "$runid" "$replicas" ;;
  *) exit 1 ;;
esac
`,
      { mode: 0o700 },
    );
  });
  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  const check = (scenario: string) =>
    execFileSync("sh", ["-ec", redisSentinelReadiness("database", 3)], {
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        SCENARIO: scenario,
        PRIMARY_ID: "a".repeat(40),
      },
      stdio: "pipe",
    });

  it("accepts all voters knowing the writable primary and all replicas", () => {
    expect(() => check("ready")).not.toThrow();
  });
  it.each([
    "unavailable",
    "partial-quorum",
    "forgotten-replicas",
    "missing-replica",
    "stale-replicas",
    "disconnected",
    "stale-primary",
  ])("rejects an otherwise healthy group when the final voter is %s", (scenario) => {
    expect(() => check(scenario)).toThrow();
  });
  it.each([0, 1, 2.5, 9, NaN, Infinity])("rejects an invalid replica count %s", (replicas) => {
    expect(() => redisSentinelReadiness("database", replicas)).toThrow();
  });
});
