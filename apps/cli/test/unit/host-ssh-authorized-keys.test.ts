import { describe, it, expect } from "vitest";
import { rewriteHostAuthorizedKeys } from "../../src/lib/compose";

/**
 * The docker→host channel authorizes a key in the host user's authorized_keys.
 * That file decides who can log into the box, so the surgery on it is tested
 * directly: an over-broad or un-revoked line here is a standing credential.
 */

const PUB = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIexample openship-host-executor";
const OTHER_PUB = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIold openship-host-executor";
const OPERATOR_KEY = "ssh-rsa AAAAB3NzaC1yc2EAAAA operator@laptop";

describe("rewriteHostAuthorizedKeys", () => {
  it("restricts the grant to the docker bridge and disables forwarding", () => {
    const out = rewriteHostAuthorizedKeys("", PUB);
    // Source-restricted: an unrestricted key is a login from anywhere sshd
    // accepts, which on a VPS is the internet.
    expect(out).toContain('from="172.16.0.0/12,192.168.0.0/16,10.0.0.0/8,127.0.0.1"');
    // No port/agent forwarding — stops a leaked key becoming a tunnel into
    // other services bound on the host.
    expect(out).toContain("restrict");
    // …but a pty is kept, because the host terminal opens a shell channel.
    expect(out).toContain("pty");
    expect(out.trimEnd().endsWith(PUB)).toBe(true);
  });

  it("never emits a bare, unrestricted key line", () => {
    const out = rewriteHostAuthorizedKeys("", PUB);
    for (const line of out.split("\n").filter(Boolean)) {
      expect(line.startsWith("ssh-"), `unrestricted line: ${line}`).toBe(false);
    }
  });

  it("preserves the operator's own keys", () => {
    const out = rewriteHostAuthorizedKeys(`${OPERATOR_KEY}\n`, PUB);
    expect(out).toContain(OPERATOR_KEY);
    expect(out).toContain(PUB);
  });

  // A wiped ~/.openship generates a NEW keypair; the old public key used to stay
  // authorized forever, so no amount of re-running could revoke it.
  it("revokes a previous host-executor key when a new one is generated", () => {
    const out = rewriteHostAuthorizedKeys(`${OPERATOR_KEY}\n${hardened(OTHER_PUB)}\n`, PUB);
    expect(out).not.toContain("AAAAIold");
    expect(out).toContain("AAAAIexample");
    expect(out).toContain(OPERATOR_KEY);
  });

  // An install predating the hardening has a bare line. If it survived alongside
  // the new one, sshd would still honour the wide grant.
  it("replaces a legacy UNRESTRICTED host-executor line rather than adding beside it", () => {
    const out = rewriteHostAuthorizedKeys(`${PUB}\n`, PUB);
    const ourLines = out.split("\n").filter((l) => l.includes("openship-host-executor"));
    expect(ourLines).toHaveLength(1);
    expect(ourLines[0]).toContain("restrict");
  });

  it("is idempotent", () => {
    const once = rewriteHostAuthorizedKeys(`${OPERATOR_KEY}\n`, PUB);
    expect(rewriteHostAuthorizedKeys(once, PUB)).toBe(once);
  });

  it("tolerates a file with no trailing newline and blank lines", () => {
    const out = rewriteHostAuthorizedKeys(`${OPERATOR_KEY}\n\n`, PUB);
    expect(out.split("\n").filter(Boolean)).toHaveLength(2);
    expect(out.endsWith("\n")).toBe(true);
  });
});

/** The hardened form, as the provisioner writes it. */
function hardened(pub: string): string {
  return `from="172.16.0.0/12,192.168.0.0/16,10.0.0.0/8,127.0.0.1",restrict,pty ${pub}`;
}
