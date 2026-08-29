import { describe, it, expect, vi } from "vitest";
import { envOps, type CommandExecutor } from "@repo/adapters";

// The real fixture rather than a hand-rolled profile literal: this exercises the actual
// resolver + privilege gate, so a probe shape change must break it rather than pass.
import {
  OS_RELEASE,
  probeOutput,
  profileFixture,
} from "../../../../packages/adapters/src/system/environment.fixtures";
import {
  OPENSHIP_DIR,
  openshipFileExists,
  readOpenshipFile,
  writeOpenshipFile,
} from "./openship-server-store";

/**
 * Privilege for the server state store.
 *
 * `.openship` is 0700 root-owned by design, so on a host we log in to as a non-root user
 * EVERY operation here needs elevation — including the reads, which is the half that hid:
 * a `cat` of a file the login user could never have written returns "" and is
 * indistinguishable from "this server has no Openship state", which is exactly what
 * `scan` reads to re-import our own projects.
 *
 * A fresh executor object per case on purpose: the profile is cached per executor
 * identity, so sharing one would leak the first case's host into the rest.
 */
function fakeHost(probe: string, fileBody = "PAYLOAD") {
  const commands: string[] = [];
  const writes: string[] = [];

  const executor = {
    exec: async (command: string) => {
      commands.push(command);
      if (command.includes("opsh_begin")) return probe;
      if (command.includes("cat ")) return fileBody;
      if (command.includes("test -f")) return "yes";
      return "";
    },
    writeFile: async (path: string) => {
      writes.push(path);
    },
  } as unknown as CommandExecutor;

  // The store's own commands. The probe is filtered out because it carries a `sudo -n
  // true` of its own — a bare "no sudo anywhere" assertion would always fail.
  const stored = () => commands.filter((c) => !c.includes("opsh_begin"));

  return { executor, commands, writes, stored };
}

const NON_ROOT_SUDO = probeOutput({
  uid: "1000",
  user: "deploy",
  home: "/home/deploy",
  sudo: "y",
});
const NON_ROOT_NO_SUDO = probeOutput({
  uid: "1000",
  user: "deploy",
  home: "/home/deploy",
  sudo: "n",
});
/** The ordinary managed host: root login, no elevation needed anywhere. */
const ROOT = probeOutput();

describe("openship-server-store privilege", () => {
  it("elevates every operation on a non-root login, without moving the path", async () => {
    const write = fakeHost(NON_ROOT_SUDO);
    await writeOpenshipFile(write.executor, "manifest.json", "{}");

    // Staged through a user-writable temp, then moved into the root-owned dir as root —
    // SFTP has no shell and cannot be elevated, so a direct write would EACCES.
    expect(write.writes).toHaveLength(1);
    expect(write.writes[0]!.startsWith("/tmp/")).toBe(true);
    // Two hops, both as root: the staging mv out of /tmp, then the atomic promote.
    const mv = write.stored().filter((c) => c.includes("mv -f"));
    expect(mv).toHaveLength(2);
    expect(mv.every((c) => c.includes("sudo -n sh -c"))).toBe(true);
    expect(mv[0]).toContain(`${OPENSHIP_DIR}/manifest.json.tmp`);
    expect(mv[1]).toContain(`${OPENSHIP_DIR}/manifest.json`);

    const read = fakeHost(NON_ROOT_SUDO);
    expect(await readOpenshipFile(read.executor, "manifest.json")).toBe("PAYLOAD");
    expect(read.stored().find((c) => c.includes("cat "))).toContain("sudo -n sh -c");

    const stat = fakeHost(NON_ROOT_SUDO);
    expect(await openshipFileExists(stat.executor, "manifest.json")).toBe(true);
    expect(stat.stored().find((c) => c.includes("test -f"))).toContain("sudo -n sh -c");
  });

  it("leaves a root login exactly as it was — no sudo, same path", async () => {
    const { executor, stored, writes } = fakeHost(probeOutput());
    await writeOpenshipFile(executor, "manifest.json", "{}");

    expect(writes).toEqual([`${OPENSHIP_DIR}/manifest.json.tmp`]);
    expect(stored().some((c) => c.includes("sudo"))).toBe(false);
  });

  it("still reads state on a host it could not measure", async () => {
    // A banner or forced command means no profile. Refusing here would turn a readable
    // manifest into a missing one — a regression dressed as a safety check.
    const { executor, stored } = fakeHost("Please login as the user \"ec2-user\"\n");

    expect(await readOpenshipFile(executor, "manifest.json")).toBe("PAYLOAD");
    expect(stored().some((c) => c.includes("sudo"))).toBe(false);
  });

  it("does not pretend to read on a measured host with no route to root", async () => {
    // The other side of the case above, and the two must not be merged: an unsupported
    // distro whose login is unprivileged is REFUSED by the gate yet proceeds anyway
    // (`onRefusedHost: "proceed"`), so it arrives here with no elevation at all. Unlike
    // the unmeasurable box, `isRoot`/`canSudo` here are facts — /root is 0700, the read
    // cannot work, and the shell cannot say so: `cat … || echo ""` exits 0 either way, so
    // "forbidden" came back as a successful empty answer and `scan` read it as a server
    // with no Openship projects. The distinction is only visible before the command is sent.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { executor, stored } = fakeHost(
        probeOutput({
          osRelease: OS_RELEASE.opensuse156,
          pm: "none",
          uid: "1000",
          user: "deploy",
          home: "/home/deploy",
          sudo: "n",
        }),
      );

      expect(await readOpenshipFile(executor, "manifest.json")).toBe("");
      // Not attempted, rather than attempted and discarded — the point is that the answer
      // was never going to mean anything.
      expect(stored().some((c) => c.includes("cat "))).toBe(false);
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/no route to root/);
    } finally {
      warn.mockRestore();
    }
  });

  it("names the fix when the login is measurably unprivileged", async () => {
    const write = fakeHost(NON_ROOT_NO_SUDO);
    await expect(writeOpenshipFile(write.executor, "manifest.json", "{}")).rejects.toThrow(
      /passwordless sudo/,
    );
    expect(write.writes).toEqual([]);

    // Reads stay non-throwing by contract; absent state is still absent state.
    const read = fakeHost(NON_ROOT_NO_SUDO);
    expect(await readOpenshipFile(read.executor, "manifest.json")).toBe("");
  });

  it("reports a refused read instead of silently calling it absent", async () => {
    // The compromise the line above makes is that the VALUE is ambiguous. The log
    // must not be: a host that merely denies elevation otherwise reads as a host
    // with no Openship state, and `scan` re-imports our own projects off that.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const read = fakeHost(NON_ROOT_NO_SUDO);
      expect(await readOpenshipFile(read.executor, "manifest.json")).toBe("");

      const stat = fakeHost(NON_ROOT_NO_SUDO);
      expect(await openshipFileExists(stat.executor, "manifest.json")).toBe(false);

      const messages = warn.mock.calls.map((call) => String(call[0]));
      expect(messages).toHaveLength(2);
      for (const message of messages) {
        expect(message).toContain("manifest.json");
        // The reason, not just the fact — "passwordless sudo" is the operator's fix.
        expect(message).toMatch(/passwordless sudo/);
      }
    } finally {
      warn.mockRestore();
    }
  });

  /**
   * The two remote roots DIVERGE on a non-root login, on purpose.
   *
   * The remote journal moved to the login user's home (`scratchDir()`); this store did
   * not (`/root/.openship`). Asserted against the literal rather than `OPENSHIP_DIR`
   * because the point is the divergence: a test written as `expect(…).toBe(OPENSHIP_DIR)`
   * follows the constant wherever a future "unify the paths" refactor moves it, and
   * moving THIS one strands every host provisioned before the privilege fix — the state
   * here is read back later, sometimes by a different login user, so it has to be found
   * at the path the old writer used. The journal has no such duty: it is opId-keyed
   * scratch on a 1440-minute GC, so it is free to follow the login user, and had to —
   * `/root` is unwritable over SFTP, which is the EACCES that started this.
   */
  it("keeps the store at /root while the journal follows the login user", () => {
    const nonRoot = profileFixture({
      isRoot: false,
      canSudo: true,
      loginUser: "deploy",
      home: "/home/deploy",
    });

    expect(OPENSHIP_DIR).toBe("/root/.openship");
    expect(envOps(nonRoot).scratchDir()).toBe("/home/deploy/.openship");
    // And on the ordinary root host the two are byte-identical, which is why the split
    // is invisible in production and needs pinning here.
    expect(envOps(profileFixture()).scratchDir()).toBe(OPENSHIP_DIR);
  });

  it("stays quiet when the file is genuinely absent", async () => {
    // A missing file is answered inside the shell (`|| echo ""`), so it must not
    // reach the refusal log — otherwise the warning means nothing.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const host = fakeHost(ROOT, "");
      expect(await readOpenshipFile(host.executor, "manifest.json")).toBe("");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
