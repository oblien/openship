import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  operatorSshKeyRoots,
  resolveSafeSshKeyPath,
  sshKeyPathProblem,
} from "../../src/lib/ssh-key-path";

// This guard exists so an attacker who can write the servers row can't point
// sshKeyPath at /etc/shadow and have the bytes exfiltrated through the SFTP
// private-key field. The cases below pin BOTH halves: the documented default
// roots must work, and the denylist must still hold everywhere else.

describe("resolveSafeSshKeyPath", () => {
  describe("allowed roots", () => {
    it("accepts a key under /var/lib/openship/ssh-keys", () => {
      expect(resolveSafeSshKeyPath("/var/lib/openship/ssh-keys/id_ed25519")).toBe(
        "/var/lib/openship/ssh-keys/id_ed25519",
      );
    });

    it("accepts a key under /etc/openship/ssh-keys", () => {
      // A documented DEFAULT_ROOT that sits under the broad `/etc` denylist
      // entry. config/env.ts advertises it too ("The default allowlist already
      // includes /var/lib/openship/ssh-keys and /etc/openship/ssh-keys").
      expect(resolveSafeSshKeyPath("/etc/openship/ssh-keys/id_ed25519")).toBe(
        "/etc/openship/ssh-keys/id_ed25519",
      );
    });

    it("accepts a key under a caller-supplied extra root", () => {
      expect(resolveSafeSshKeyPath("/home/op/.ssh/id_rsa", { extraRoots: ["/home/op"] })).toBe(
        "/home/op/.ssh/id_rsa",
      );
    });
  });

  describe("system denylist", () => {
    it("rejects /etc/shadow", () => {
      expect(() => resolveSafeSshKeyPath("/etc/shadow")).toThrow(
        /protected system directory \(\/etc\)/,
      );
    });

    it("rejects a sibling of the allowed root that is still under /etc", () => {
      expect(() => resolveSafeSshKeyPath("/etc/openship-secrets/key")).toThrow(
        /protected system directory \(\/etc\)/,
      );
    });

    it.each([
      ["/proc/self/environ", "/proc"],
      ["/sys/kernel/notes", "/sys"],
      ["/dev/mem", "/dev"],
      ["/boot/vmlinuz", "/boot"],
      ["/root/.ssh/id_rsa", "/root/.ssh"],
      ["/var/lib/docker/volumes/x", "/var/lib/docker"],
      ["/var/lib/postgresql/data/x", "/var/lib/postgresql"],
    ])("rejects %s", (path, denied) => {
      expect(() => resolveSafeSshKeyPath(path)).toThrow(
        `sshKeyPath is inside a protected system directory (${denied})`,
      );
    });

    it("still denies a system path reached through a permissive extra root", () => {
      // The exemption is scoped to the hardcoded DEFAULT_ROOTS only — a caller
      // passing "/" as $HOME must not unlock the denylist.
      expect(() => resolveSafeSshKeyPath("/etc/shadow", { extraRoots: ["/"] })).toThrow(
        /protected system directory/,
      );
    });
  });

  describe("operator ~/.ssh carve-out", () => {
    // The API commonly runs as root (containers), where homedir() === "/root"
    // and the operator's own key lives in /root/.ssh — which is also on the
    // denylist. A path under the *provided* home's .ssh is the operator's own
    // dir, so it's accepted; the same path with a different home stays denied.
    it("accepts <home>/.ssh even when that resolves to the denied /root/.ssh", () => {
      expect(
        resolveSafeSshKeyPath("/root/.ssh/openship", { extraRoots: ["/root"] }),
      ).toBe("/root/.ssh/openship");
    });

    it("accepts a non-root operator's ~/.ssh key", () => {
      expect(
        resolveSafeSshKeyPath("/home/op/.ssh/id_ed25519", { extraRoots: ["/home/op"] }),
      ).toBe("/home/op/.ssh/id_ed25519");
    });

    it("still denies /root/.ssh when it is NOT the provided home", () => {
      expect(() =>
        resolveSafeSshKeyPath("/root/.ssh/id_rsa", { extraRoots: ["/home/op"] }),
      ).toThrow(/protected system directory \(\/root\/\.ssh\)/);
    });

    it("stays narrow: a home root of '/' still can't unlock /etc/shadow", () => {
      // resolve("/", ".ssh") === "/.ssh", which /etc/shadow is not under.
      expect(() =>
        resolveSafeSshKeyPath("/etc/shadow", { extraRoots: ["/"] }),
      ).toThrow(/protected system directory/);
    });
  });

  describe("path shape", () => {
    it("rejects an empty or whitespace-only path", () => {
      expect(() => resolveSafeSshKeyPath("   ")).toThrow(/is empty/);
    });

    it("rejects a null byte", () => {
      expect(() => resolveSafeSshKeyPath("/var/lib/openship/ssh-keys/id\0")).toThrow(/null byte/);
    });

    it("rejects a relative path", () => {
      expect(() => resolveSafeSshKeyPath("ssh-keys/id_ed25519")).toThrow(/must be absolute/);
    });

    it("rejects a traversal segment", () => {
      expect(() => resolveSafeSshKeyPath("/var/lib/openship/ssh-keys/../../../etc/shadow")).toThrow(
        /traversal segment/,
      );
    });

    it("rejects a path outside every allowed root", () => {
      expect(() => resolveSafeSshKeyPath("/opt/somewhere/id_rsa")).toThrow(/must sit under one of/);
    });

    it("trims surrounding whitespace", () => {
      expect(resolveSafeSshKeyPath("  /var/lib/openship/ssh-keys/id_ed25519  ")).toBe(
        "/var/lib/openship/ssh-keys/id_ed25519",
      );
    });
  });
});

/**
 * The reason string the test-connection route surfaces instead of the flat
 * "Invalid auth configuration" buildSshConfig's null return used to produce. Every
 * case below is one an operator actually hits: the tilde shape the form used to
 * suggest, a key that lives on their laptop and not on this host, and a directory
 * picked by mistake in a file dialog.
 */
describe("sshKeyPathProblem", () => {
  // operatorSshKeyRoots() is $HOME, so the only place a fixture can live and be
  // accepted is under the home dir of whoever runs the suite.
  const dir = mkdtempSync(join(operatorSshKeyRoots()[0]!, ".openship-keypath-test-"));
  const key = join(dir, "id_ed25519");
  writeFileSync(key, "-----BEGIN OPENSSH PRIVATE KEY-----\n");

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("uses $HOME as a root, so a readable key there is accepted", () => {
    expect(operatorSshKeyRoots()).toEqual([homedir()]);
    expect(sshKeyPathProblem(key)).toBeNull();
  });

  it("reports a path that does not exist on THIS host", () => {
    expect(sshKeyPathProblem(join(dir, "nope"))).toMatch(/not readable by Openship/);
  });

  it("reports a directory rather than letting readFileSync fail later", () => {
    expect(sshKeyPathProblem(dir)).toMatch(/is not a file/);
  });

  it("reports the roots policy for a path outside every root", () => {
    expect(sshKeyPathProblem("/opt/keys/id_rsa")).toMatch(/must sit under one of/);
  });

  it("reports the tilde form the key-path field used to suggest", () => {
    expect(sshKeyPathProblem("~/.ssh/id_rsa")).toMatch(/must be absolute/);
  });
});
