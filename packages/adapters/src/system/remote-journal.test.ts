import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { probeOutput } from "./environment.fixtures";
import { SshDisconnectedError } from "./errors";
import { LocalExecutor } from "./local-executor";
import {
  DEFAULT_JOURNAL_BASE,
  ensureRemoteJournal,
  parseFrame,
  runJournaled,
  runReliable,
} from "./remote-journal";
import type { CommandExecutor } from "../types";

/**
 * Exercises the opsh-run wrapper end-to-end against the LOCAL machine via
 * LocalExecutor (the wrapper is POSIX + openssl, so it runs on macOS/Linux).
 * The core property under test: a command that is "still running" when the
 * caller loses it (simulated by a short wait window) is HARVESTED — not re-run —
 * when the same opId is re-driven. That is the exactly-once guarantee.
 */
describe("remote-journal", () => {
  const exec = new LocalExecutor();
  let base: string;
  let scratch: string;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), "opsh-journal-"));
    scratch = await mkdtemp(join(tmpdir(), "opsh-scratch-"));
    await ensureRemoteJournal(exec, base);
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  });

  it("runs a command exactly once across a simulated mid-flight disconnect", async () => {
    const count = join(scratch, "count");
    const done = join(scratch, "done");
    // Increments a counter at launch, then sleeps past the first wait window.
    const cmd = `n=$(cat ${count} 2>/dev/null || echo 0); echo $((n+1)) > ${count}; sleep 2; echo hi; touch ${done}`;
    const opId = "test:once:1";

    // First call: launches, but the command outlives the wait window → "running".
    // This stands in for losing the connection while the op is in flight.
    const first = await runJournaled(exec, opId, cmd, { baseDir: base, waitSecs: 1, envPrefix: "" });
    expect(first.status).toBe("running");

    // "Reconnect": re-drive the SAME opId. Must harvest the completed result.
    const second = await runJournaled(exec, opId, cmd, { baseDir: base, waitSecs: 8, envPrefix: "" });
    expect(second.status).toBe("done");
    expect(second.code).toBe(0);
    expect((second.stdout ?? "").trim()).toBe("hi");

    // A third harvest is still idempotent.
    const third = await runJournaled(exec, opId, cmd, { baseDir: base, waitSecs: 8, envPrefix: "" });
    expect(third.status).toBe("done");
    expect(third.code).toBe(0);

    // The command body ran EXACTLY ONCE despite three invocations.
    expect((await readFile(count, "utf8")).trim()).toBe("1");
    // Whether it RESOLVED, not what it resolved to: `access` yields no value on success,
    // and Node calls that `undefined` while Bun calls it `null`. The app runs on Bun, so a
    // test that pins the resolution value fails on the runtime that matters.
    expect(await access(done).then(() => true, () => false)).toBe(true);
  }, 20_000);

  it("captures a non-zero exit code and stderr", async () => {
    const r = await runJournaled(exec, "test:fail:1", "echo boom >&2; exit 7", {
      baseDir: base,
      waitSecs: 5,
      envPrefix: "",
    });
    expect(r.status).toBe("done");
    expect(r.code).toBe(7);
    expect((r.stderr ?? "").trim()).toBe("boom");
  }, 20_000);

  it("detects an opId reused with a different command (collision)", async () => {
    const opId = "test:collision:1";
    const a = await runJournaled(exec, opId, "echo a", { baseDir: base, waitSecs: 5, envPrefix: "" });
    expect(a.status).toBe("done");
    const b = await runJournaled(exec, opId, "echo DIFFERENT", { baseDir: base, waitSecs: 5, envPrefix: "" });
    expect(b.status).toBe("collision");
  }, 20_000);

  it("parses wrapper frames", () => {
    const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
    expect(parseFrame(`OPSH1 0 ${b64("out")} ${b64("err")}`)).toEqual({
      status: "done",
      code: 0,
      stdout: "out",
      stderr: "err",
    });
    expect(parseFrame("OPSH-RUNNING 1234").status).toBe("running");
    expect(parseFrame("OPSH-DEAD").status).toBe("dead");
    expect(parseFrame("OPSH-COLLISION").status).toBe("collision");
    expect(parseFrame("OPSH-EIO disk full").status).toBe("eio");
  });
});

/**
 * Where `runReliable` puts the journal when the caller does NOT name a base dir.
 *
 * The wrapper is deployed over SFTP, which has no shell and so cannot be elevated at
 * all — a root-anchored base is therefore unwritable on any host we log in to as a
 * non-root user, however much sudo that user has. That failure landed on the deploy's
 * activation step (issue #514): built, uploaded, then EACCES writing `bin/opsh-run.tmp`,
 * and `Permission denied` is not retryable, so it escaped as a hard failure.
 */
describe("remote-journal base dir", () => {
  /** Records what was run/written and walks one op straight through to a done frame. */
  function fake(probe: string, opts: { failProbeOnce?: Error } = {}) {
    const commands: string[] = [];
    const writes: string[] = [];
    const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
    let probeFailure = opts.failProbeOnce;

    const executor = {
      exec: async (command: string) => {
        commands.push(command);
        if (command.includes("opsh_begin")) {
          if (probeFailure) {
            const err = probeFailure;
            probeFailure = undefined;
            throw err;
          }
          return probe;
        }
        // A missing version forces the deploy — the writeFile under test.
        if (command.includes("--version")) return "";
        if (command.includes("--wait")) return `OPSH1 0 ${b64("ok")} ${b64("")}`;
        return "";
      },
      writeFile: async (path: string) => {
        writes.push(path);
      },
    } as unknown as CommandExecutor;

    return { executor, commands, writes };
  }

  it("deploys the wrapper under the login user's home, not /root", async () => {
    const { executor, commands, writes } = fake(
      probeOutput({ uid: "1000", user: "deploy", home: "/home/deploy", sudo: "y" }),
    );

    const r = await runReliable(async () => executor, "op:nonroot:1", "true", {
      waitSecs: 1,
    });

    expect(r.code).toBe(0);
    // The exact call that raised EACCES on a non-root host.
    expect(writes).toEqual(["/home/deploy/.openship/bin/opsh-run.tmp"]);
    expect(writes.some((p) => p.startsWith("/root/"))).toBe(false);
    // And the op itself journals to the same base — a split would break the harvest.
    expect(commands.some((c) => c.includes("/home/deploy/.openship/bin/opsh-run"))).toBe(true);
    expect(commands.some((c) => c.includes("/root/.openship"))).toBe(false);
  });

  it("still resolves /root for a root login, so nothing moves on a working host", async () => {
    const { executor, writes } = fake(probeOutput());

    await runReliable(async () => executor, "op:root:1", "true", { waitSecs: 1 });

    expect(writes).toEqual([`${DEFAULT_JOURNAL_BASE}/bin/opsh-run.tmp`]);
  });

  it("falls back to the constant when the host cannot be measured", async () => {
    // An unbracketed answer is how the detector reports "I could not measure this box"
    // (a forced command, a chatty banner). A deploy must not fail over a scratch dir.
    const { executor, writes } = fake("Please login as the user \"ec2-user\"\n");

    await runReliable(async () => executor, "op:unmeasured:1", "true", { waitSecs: 1 });

    expect(writes).toEqual([`${DEFAULT_JOURNAL_BASE}/bin/opsh-run.tmp`]);
  });

  /**
   * `resolveEnvironment` throws for exactly one reason — the transport dropped — and
   * absorbs every command-level failure into a profile. Swallowing that throw pinned the
   * base dir off a box we never reached and hid the drop from the retry loop.
   */
  it("propagates a transport drop from the base-dir probe to the retry loop", async () => {
    const { executor, writes } = fake(
      probeOutput({ uid: "1000", user: "deploy", home: "/home/deploy", sudo: "y" }),
      { failProbeOnce: new SshDisconnectedError() },
    );
    const drops: unknown[] = [];

    const r = await runReliable(async () => executor, "op:drop:1", "true", {
      waitSecs: 1,
      reconnectMinMs: 1,
      onRetryableDrop: (err) => drops.push(err),
    });

    expect(r.code).toBe(0);
    expect(drops).toHaveLength(1);
    // Re-probed on the retry, so the base dir is the host's real answer.
    expect(writes).toEqual(["/home/deploy/.openship/bin/opsh-run.tmp"]);
  });

  it("still absorbs a command-level probe failure without reporting a drop", async () => {
    const { executor, writes } = fake(probeOutput(), {
      failProbeOnce: new Error("sudo: a password is required"),
    });
    const drops: unknown[] = [];

    const r = await runReliable(async () => executor, "op:probefail:1", "true", {
      waitSecs: 1,
      reconnectMinMs: 1,
      onRetryableDrop: (err) => drops.push(err),
    });

    expect(r.code).toBe(0);
    expect(drops).toEqual([]);
    expect(writes).toEqual([`${DEFAULT_JOURNAL_BASE}/bin/opsh-run.tmp`]);
  });

  it("honours an explicit baseDir over the host's own answer", async () => {
    const { executor, writes } = fake(
      probeOutput({ uid: "1000", user: "deploy", home: "/home/deploy", sudo: "y" }),
    );

    await runReliable(async () => executor, "op:explicit:1", "true", {
      baseDir: "/srv/journal",
      waitSecs: 1,
    });

    expect(writes).toEqual(["/srv/journal/bin/opsh-run.tmp"]);
  });
});
