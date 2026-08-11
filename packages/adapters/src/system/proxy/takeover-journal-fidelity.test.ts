import { describe, expect, it, vi } from "vitest";

import { OS_RELEASE, probeOutput, type ProbeSpec } from "../environment.fixtures";
import type { CommandExecutor } from "../../types";
import type { EdgeStatus, SystemLog } from "../types";
import {
  buildJournal,
  readJournal,
  rollback,
  JOURNAL_PATH,
  type TakeoverJournal,
} from "./takeover-journal";

/**
 * The journal is the only record of how to put someone else's proxy back. Two ways it
 * was quietly lying:
 *
 * 1. A REFUSED `docker inspect` was recorded as `restart: "no"` — indistinguishable
 *    from a container that really had no policy. `rollback` writes that value back with
 *    `docker update --restart=`, so an `always` container we were never allowed to look
 *    at came back once and then never again after a reboot, and the takeover reported
 *    clean throughout.
 * 2. It is WRITTEN as root into root-owned `/var/lib/openship` and was READ on the raw
 *    executor. On a box whose state dir an operator has tightened, the refused `cat`
 *    returned null, and every caller reads null as "no unfinished takeover" — so boot
 *    recovery declined, silently, to restore a proxy this machine had already stopped.
 */
const CONTAINER_STATUS: EdgeStatus = {
  classification: "known",
  canProceedClean: false,
  occupants: [{ port: 80, containerName: "caddy", proxy: "caddy", managedByOpenship: false }],
};

const ROOT: ProbeSpec = { osRelease: OS_RELEASE.ubuntu2404 };
const NON_ROOT_SUDO: ProbeSpec = {
  osRelease: OS_RELEASE.ubuntu2404,
  uid: "1000",
  user: "deploy",
  home: "/home/deploy",
  sudo: "y",
};

/**
 * `inspect`: what `docker inspect` answers, or "refuse" to fail the way a login with no
 * access to the socket does. `journal`: the file's contents, "unreadable" for a file
 * that exists but whose mode refuses us, or undefined for genuinely absent.
 */
function host(
  spec: ProbeSpec,
  opts: { inspect?: string | "refuse"; journal?: string | "unreadable"; serving?: boolean } = {},
) {
  const commands: string[] = [];
  const executor = {
    exec: vi.fn(async (command: string) => {
      commands.push(command);
      if (command.includes("opsh_begin")) return probeOutput(spec);
      if (command.includes("docker inspect")) {
        if (opts.inspect === "refuse") {
          throw new Error("permission denied while trying to connect to the Docker daemon socket");
        }
        return opts.inspect ?? "";
      }
      if (command.includes(`cat ${JOURNAL_PATH}`)) {
        if (opts.journal === undefined) throw new Error("cat: no such file or directory");
        if (opts.journal === "unreadable") throw new Error("cat: Permission denied");
        return opts.journal;
      }
      if (command.includes(`ls ${JOURNAL_PATH}`)) {
        if (opts.journal === undefined) throw new Error("ls: cannot access");
        return `${JOURNAL_PATH}\n`;
      }
      if (command.includes("ss -ltn")) return opts.serving === false ? "" : "yes";
      return "";
    }),
    streamExec: vi.fn(async () => ({ code: 0, output: "" })),
    writeFile: vi.fn(async () => {}),
    readFile: vi.fn(async () => ""),
    exists: vi.fn(async () => true),
    mkdir: vi.fn(async () => {}),
    rm: vi.fn(async () => {}),
  } as unknown as CommandExecutor;
  return { executor, commands };
}

const noop = () => {};

describe("buildJournal records a restart policy only when it read one", () => {
  it("leaves it unset when the inspect is refused, and says so", async () => {
    const logs: SystemLog[] = [];
    const { executor } = host(ROOT, { inspect: "refuse" });

    const journal = await buildJournal(executor, CONTAINER_STATUS, (l) => logs.push(l));

    expect(journal.containers).toEqual([{ name: "caddy" }]);
    expect("restart" in journal.containers[0]).toBe(false);
    const said = logs.map((l) => l.message).join("\n");
    expect(said).toContain("Could not read caddy's restart policy");
    expect(said).toContain("docker inspect");
  });

  it("keeps an ANSWERED empty policy as \"no\" — that is a reading, not a refusal", async () => {
    // Pre-25 Docker spells "no restart policy" as the empty string. Folding it in with
    // the refusal is what made `|| "no"` look correct.
    const logs: SystemLog[] = [];
    const { executor } = host(ROOT, { inspect: "  \n" });

    const journal = await buildJournal(executor, CONTAINER_STATUS, (l) => logs.push(l));

    expect(journal.containers).toEqual([{ name: "caddy", restart: "no" }]);
    expect(logs).toEqual([]);
  });

  it("records the policy it was given", async () => {
    const { executor } = host(ROOT, { inspect: "always\n" });

    expect((await buildJournal(executor, CONTAINER_STATUS)).containers).toEqual([
      { name: "caddy", restart: "always" },
    ]);
  });
});

describe("rollback never writes back a policy it did not read", () => {
  const journalWith = (restart?: string): TakeoverJournal => ({
    startedAt: new Date().toISOString(),
    units: [],
    containers: [restart ? { name: "caddy", restart } : { name: "caddy" }],
    processes: [],
  });

  it("starts the container but leaves its policy alone, and warns", async () => {
    const logs: SystemLog[] = [];
    const { executor, commands } = host(NON_ROOT_SUDO);

    expect(await rollback(executor, journalWith(), (l) => logs.push(l))).toBe(true);

    expect(commands.some((c) => c.includes("docker start") && c.includes("caddy"))).toBe(true);
    // Never `--restart=no` on a container whose policy we never read: that survives the
    // run and takes the reboot with it.
    expect(commands.some((c) => c.includes("docker update --restart") && c.includes("caddy"))).toBe(
      false,
    );
    expect(logs.map((l) => l.message).join("\n")).toContain("without setting a restart policy");
  });

  it("still restores a policy that WAS captured", async () => {
    const logs: SystemLog[] = [];
    const { executor, commands } = host(NON_ROOT_SUDO);

    await rollback(executor, journalWith("unless-stopped"), (l) => logs.push(l));

    expect(
      commands.some(
        (c) =>
          c.includes("docker update --restart") && c.includes("unless-stopped") && c.includes("caddy"),
      ),
    ).toBe(true);
    expect(logs.map((l) => l.message).join("\n")).not.toContain("without setting a restart policy");
  });
});

describe("readJournal", () => {
  const JOURNAL: TakeoverJournal = {
    startedAt: "2026-01-01T00:00:00.000Z",
    units: [{ unit: "nginx.service", wasEnabled: true }],
    containers: [],
    processes: [],
  };

  it("reads it back through the executor that wrote it", async () => {
    const { executor, commands } = host(NON_ROOT_SUDO, { journal: JSON.stringify(JOURNAL) });

    expect(await readJournal(executor)).toEqual(JOURNAL);
    // The write is elevated; a read that isn't cannot see what the write produced.
    expect(
      commands.some((c) => c.startsWith("sudo -n sh -c ") && c.includes(`cat ${JOURNAL_PATH}`)),
    ).toBe(true);
  });

  it("stays silent when there is simply no journal — that is every normal boot", async () => {
    const logs: SystemLog[] = [];
    const { executor } = host(ROOT);

    expect(await readJournal(executor, (l) => logs.push(l))).toBeNull();
    expect(logs).toEqual([]);
  });

  it("says a journal it cannot read is NOT the same as no journal", async () => {
    const logs: SystemLog[] = [];
    const { executor } = host(ROOT, { journal: "unreadable" });

    expect(await readJournal(executor, (l) => logs.push(l))).toBeNull();
    const said = logs.map((l) => l.message).join("\n");
    expect(said).toContain("could not read it as this user");
    expect(said).toContain("will NOT be restored automatically");
    expect(logs.every((l) => l.level === "error")).toBe(true);
  });

  it("clears an empty journal instead of re-probing it every boot", async () => {
    const { executor, commands } = host(ROOT, { journal: "" });

    expect(await readJournal(executor)).toBeNull();
    expect(commands.some((c) => c.includes(`rm -f ${JOURNAL_PATH}`))).toBe(true);
  });

  it("clears an unparseable journal", async () => {
    const { executor, commands } = host(ROOT, { journal: "{not json" });

    expect(await readJournal(executor)).toBeNull();
    expect(commands.some((c) => c.includes(`rm -f ${JOURNAL_PATH}`))).toBe(true);
  });
});
