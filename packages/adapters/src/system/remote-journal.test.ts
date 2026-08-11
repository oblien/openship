import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalExecutor } from "./local-executor";
import { ensureRemoteJournal, parseFrame, runJournaled } from "./remote-journal";

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
    await expect(access(done)).resolves.toBeUndefined();
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
