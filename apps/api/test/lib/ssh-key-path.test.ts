import { describe, expect, it } from "vitest";

import { resolveSafeSshKeyPath } from "../../src/lib/ssh-key-path";

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
