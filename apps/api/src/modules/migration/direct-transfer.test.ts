import { describe, expect, test } from "vitest";
import type { CommandExecutor } from "@repo/adapters";
import { establishDirectLink, parseRsyncProgress, rsyncCommand, runRsync, sq, statPath } from "./direct-transfer";

describe("statPath (file vs dir vs missing)", () => {
  const oneShot = (reply: string): CommandExecutor =>
    ({ exec: async () => reply }) as unknown as CommandExecutor;
  test("classifies dir / file / missing from the probe output", async () => {
    expect(await statPath(oneShot("dir\n"), "/x")).toBe("dir");
    expect(await statPath(oneShot("file"), "/x")).toBe("file");
    expect(await statPath(oneShot("missing"), "/x")).toBe("missing");
  });
  test("treats an exec failure as missing", async () => {
    const throwing = {
      exec: async () => {
        throw new Error("ssh down");
      },
    } as unknown as CommandExecutor;
    expect(await statPath(throwing, "/x")).toBe("missing");
  });
});

describe("rsyncCommand file-vs-dir slash (the postgresql.conf bug)", () => {
  const peer = { host: "10.0.0.2", port: 22, user: "root" };
  test("dir=false (a file) → NO trailing slash → rsync copies the file, not change_dir", () => {
    const cmd = rsyncCommand("ssh -i k", peer, "/a/postgresql.conf", "/b/postgresql.conf", true, false, false);
    expect(cmd).toContain("'/a/postgresql.conf'");
    expect(cmd).not.toContain("'/a/postgresql.conf'/");
    expect(cmd).not.toContain("postgresql.conf'/");
  });
  test("dir=true (a directory) → trailing slash → sync CONTENTS", () => {
    const cmd = rsyncCommand("ssh -i k", peer, "/a", "/b", true, false, true);
    expect(cmd).toContain("'/a'/");
  });
});

describe("rsyncCommand resume flags", () => {
  const peer = { host: "10.0.0.2", port: 22, user: "root" };
  test("includes --partial and --partial-dir so a re-invoke resumes", () => {
    const cmd = rsyncCommand("ssh -i k", peer, "/a", "/b", true, false);
    expect(cmd).toContain("--partial");
    expect(cmd).toContain("--partial-dir=.openship-partial");
  });
});

describe("runRsync retry / bail", () => {
  const exec = (results: Array<{ code: number; output: string }>): CommandExecutor & { calls: number } => {
    let i = 0;
    const o = {
      calls: 0,
      async streamExec() {
        o.calls++;
        return results[Math.min(i++, results.length - 1)];
      },
    };
    return o as unknown as CommandExecutor & { calls: number };
  };

  test("resolves on a first-attempt success (one call, no retry)", async () => {
    const e = exec([{ code: 0, output: "" }]);
    await expect(runRsync(e, "rsync ...")).resolves.toBeUndefined();
    expect(e.calls).toBe(1);
  });

  test("bails immediately on permission-denied (not retried)", async () => {
    const e = exec([{ code: 23, output: "rsync: mkstemp failed: Permission denied (13)" }]);
    await expect(runRsync(e, "rsync ...")).rejects.toThrow(/cannot read\/write the Docker volume path/i);
    expect(e.calls).toBe(1);
  });
});

// ── Pure helpers ──────────────────────────────────────────────────────────────

describe("parseRsyncProgress", () => {
  test("extracts cumulative bytes from an --info=progress2 line", () => {
    expect(parseRsyncProgress("      1,234,567  12%  1.23MB/s    0:00:05")).toBe(1234567);
    expect(parseRsyncProgress("  512  100%  0.50MB/s    0:00:00 (xfr#1, to-chk=0/1)")).toBe(512);
  });
  test("returns null for non-progress lines", () => {
    expect(parseRsyncProgress("sending incremental file list")).toBeNull();
    expect(parseRsyncProgress("./")).toBeNull();
    expect(parseRsyncProgress("")).toBeNull();
  });
});

describe("sq", () => {
  test("single-quotes and escapes embedded quotes", () => {
    expect(sq("a b")).toBe("'a b'");
    expect(sq("it's")).toBe("'it'\\''s'");
  });
});

describe("rsyncCommand", () => {
  const peer = { host: "10.0.0.2", port: 22, user: "root" };
  const ssh = "ssh -i /tmp/k/id -p 22";

  test("adds -z only when compress is on", () => {
    expect(rsyncCommand(ssh, peer, "/src", "/dst", true, true)).toContain(" -z ");
    expect(rsyncCommand(ssh, peer, "/src", "/dst", true, false)).not.toContain(" -z ");
  });

  test("push puts the peer on the DEST side; pull on the SOURCE side", () => {
    const push = rsyncCommand(ssh, peer, "/local", "/remote", true, false);
    expect(push).toMatch(/'\/local'\/\s+'root@10\.0\.0\.2:\/remote'\//);
    const pull = rsyncCommand(ssh, peer, "/local", "/remote", false, false);
    expect(pull).toMatch(/'root@10\.0\.0\.2:\/remote'\/\s+'\/local'\//);
  });
});

// ── establishDirectLink direction selection ─────────────────────────────────────

interface Handler {
  match: RegExp;
  reply: string;
}
function fakeExec(handlers: Handler[]): CommandExecutor & { calls: string[] } {
  const calls: string[] = [];
  const exec = async (command: string) => {
    calls.push(command);
    const h = handlers.find((x) => x.match.test(command));
    return h ? h.reply : "";
  };
  return {
    calls,
    exec,
    // streamExec unused by establishDirectLink; stub for the interface.
    streamExec: async () => ({ code: 0, output: "" }),
  } as unknown as CommandExecutor & { calls: string[] };
}

const PUBKEY = "ssh-ed25519 AAAAKEY";
const conn = (host: string) => ({ host, port: 22, user: "root" });

/** Handlers that make a bootstrap succeed on whichever exec is the initiator. */
const bootstrapOk: Handler[] = [
  { match: /ssh-keygen/, reply: "" },
  { match: /cat .*id\.pub/, reply: PUBKEY },
  { match: /ssh-keyscan/, reply: "420" }, // wc -c > 0
];

describe("establishDirectLink", () => {
  test("push: source reaches target → direction 'push'", async () => {
    const sourceExec = fakeExec([
      ...bootstrapOk,
      { match: /OPENSHIP_LINK_OK/, reply: "OPENSHIP_LINK_OK\n" },
    ]);
    const targetExec = fakeExec([]); // just receives the authorized_keys install
    const link = await establishDirectLink({
      sourceExec,
      targetExec,
      sourceConn: conn("10.0.0.1"),
      targetConn: conn("10.0.0.2"),
      runId: "run1",
      log: () => {},
    });
    expect(link?.direction).toBe("push");
    // Cleanup strips the run marker on the peer (target) and removes the temp key.
    await link!.cleanup();
    expect(targetExec.calls.some((c) => /grep -v .*openship-migration-run1-push/.test(c))).toBe(true);
    expect(sourceExec.calls.some((c) => /rm -rf .*openship-migration-run1-push/.test(c))).toBe(true);
  });

  test("push blocked, pull works → direction 'pull'", async () => {
    // Source probe fails; target (pull initiator) probe succeeds.
    const sourceExec = fakeExec([
      ...bootstrapOk,
      { match: /OPENSHIP_LINK_OK/, reply: "" }, // push probe: unreachable
    ]);
    const targetExec = fakeExec([
      ...bootstrapOk,
      { match: /OPENSHIP_LINK_OK/, reply: "OPENSHIP_LINK_OK" },
    ]);
    const link = await establishDirectLink({
      sourceExec,
      targetExec,
      sourceConn: conn("10.0.0.1"),
      targetConn: conn("10.0.0.2"),
      runId: "run2",
      log: () => {},
    });
    expect(link?.direction).toBe("pull");
  });

  test("neither direction connects → null", async () => {
    const unreachable = () =>
      fakeExec([...bootstrapOk, { match: /OPENSHIP_LINK_OK/, reply: "" }]);
    const link = await establishDirectLink({
      sourceExec: unreachable(),
      targetExec: unreachable(),
      sourceConn: conn("10.0.0.1"),
      targetConn: conn("10.0.0.2"),
      runId: "run3",
      log: () => {},
    });
    expect(link).toBeNull();
  });
});
