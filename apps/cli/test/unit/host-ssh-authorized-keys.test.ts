import { describe, it, expect, vi } from "vitest";

/**
 * Pin the box these assertions are about (Ubuntu, systemd) instead of measuring the
 * machine running the suite. `renderHostChannelIssue` now names the sshd unit THIS host
 * answers to, so left unmocked its remedy is `systemsetup -setremotelogin` on a mac and
 * `rc-service sshd` on Alpine. Only the resolver is replaced — the command is still
 * rendered by the real `envOps`, so this can't drift from the one table.
 */
vi.mock("@repo/adapters", async (importOriginal) => {
  const fixtures = await import("../../../../packages/adapters/src/system/environment.fixtures");
  return {
    ...(await importOriginal<typeof import("@repo/adapters")>()),
    resolveLocalEnvironmentSync: () => fixtures.profileFixture(),
  };
});

import {
  rewriteHostAuthorizedKeys,
  stripHostAuthorizedKeys,
  chooseHostChannelUser,
  listensOnPort,
  renderHostChannelIssue,
  sshdRefusesRootLogin,
} from "../../src/lib/compose";

/**
 * The docker→host channel authorizes a key in the host user's authorized_keys.
 * That file decides who can log into the box, so the surgery on it is tested
 * directly: an over-broad or un-revoked line here is a standing credential.
 *
 * The tail of this file covers the other two decisions provisioning makes without a
 * packet: whether the host runs an SSH server at all, and what `up` says when the
 * channel didn't come out working (#509).
 */

const PUB = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIexample openship-host-executor";
const OTHER_PUB = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIold openship-host-executor";
const OPERATOR_KEY = "ssh-rsa AAAAB3NzaC1yc2EAAAA operator@laptop";

describe("rewriteHostAuthorizedKeys", () => {
  it("restricts the grant to the docker bridge, keeping only the two capabilities we use", () => {
    const out = rewriteHostAuthorizedKeys("", PUB);
    // Source-restricted: an unrestricted key is a login from anywhere sshd
    // accepts, which on a VPS is the internet.
    expect(out).toContain('from="172.16.0.0/12,192.168.0.0/16,10.0.0.0/8,127.0.0.1"');
    // Fail-closed baseline: agent forwarding, X11 and ~/.ssh/rc stay off, and so
    // does anything OpenSSH adds later.
    expect(out).toContain("restrict");
    // …with a pty named back, because the host terminal opens a shell channel.
    expect(out).toContain("pty");
    expect(out.trimEnd().endsWith(PUB)).toBe(true);
  });

  // GH-583. The deploy readiness probe reaches `127.0.0.1:<hostPort>` — an address that
  // only means the right thing from the host — over an ssh2 direct-tcpip channel, which
  // `restrict` alone forbids. sshd then refused the channel open, the refusal looked
  // exactly like a closed port, and every readiness-gated deploy on a Compose install
  // failed with "the app never answered" while curl on the host returned 200.
  it("permits port forwarding, which the deploy-time readiness probe needs", () => {
    expect(rewriteHostAuthorizedKeys("", PUB)).toContain("port-forwarding");
  });

  // Re-running `openship up` is the repair path for an install provisioned before that
  // fix, so the revoke-and-replace must actually swap a forwarding-less line.
  it("replaces a forwarding-less line from an earlier install", () => {
    const out = rewriteHostAuthorizedKeys(
      `from="172.16.0.0/12,192.168.0.0/16,10.0.0.0/8,127.0.0.1",restrict,pty ${PUB}\n`,
      PUB,
    );
    const ourLines = out.split("\n").filter((l) => l.includes("openship-host-executor"));
    expect(ourLines).toHaveLength(1);
    expect(ourLines[0]).toContain("port-forwarding");
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

/**
 * The `--no-host-control` half. The flag's copy says the channel's key is taken back,
 * and it used to leave the authorized line in place — "off" was true of this install's
 * behaviour and false of the box's attack surface, which is the half the flag is set for.
 */
describe("stripHostAuthorizedKeys", () => {
  it("drops our line and leaves the operator's alone", () => {
    const out = stripHostAuthorizedKeys(`${OPERATOR_KEY}\n${hardened(PUB)}\n`);
    expect(out).toBe(`${OPERATOR_KEY}\n`);
  });

  it("drops a legacy unrestricted line too, so a pre-hardening install is revoked", () => {
    expect(stripHostAuthorizedKeys(`${OPERATOR_KEY}\n${PUB}\n`)).toBe(`${OPERATOR_KEY}\n`);
  });

  it("drops every one of ours, not just the last", () => {
    const out = stripHostAuthorizedKeys(
      `${hardened(OTHER_PUB)}\n${OPERATOR_KEY}\n${hardened(PUB)}\n`,
    );
    expect(out).not.toContain("openship-host-executor");
    expect(out).toContain(OPERATOR_KEY);
  });

  it("empties a file that held nothing else — no stray newline for sshd to read", () => {
    expect(stripHostAuthorizedKeys(`${hardened(PUB)}\n`)).toBe("");
  });

  it("leaves a file with none of ours byte-identical in content", () => {
    expect(stripHostAuthorizedKeys(`${OPERATOR_KEY}\n`)).toBe(`${OPERATOR_KEY}\n`);
  });
});

/** The hardened form, as the provisioner writes it. */
function hardened(pub: string): string {
  return `from="172.16.0.0/12,192.168.0.0/16,10.0.0.0/8,127.0.0.1",restrict,pty,port-forwarding ${pub}`;
}

/**
 * Which account the container→host channel logs in as.
 *
 * A LIST, not a choice: `authorized_keys` is a file we write, not a verdict sshd gives, so
 * the only thing that can establish whether an account works is dialing it. #527 is what a
 * single choice cost — a box with `PermitRootLogin no` got the root arm, the key went into a
 * file sshd never consults for a login it refuses outright, and there was nothing else to
 * try. Host ops still need root, but they do NOT need a root LOGIN (#489 is the opposite
 * mistake, and `elevation` is what keeps both from recurring).
 */
describe("chooseHostChannelUser", () => {
  it("tries root FIRST when invoked as root — `sudo openship up` is how you ask for one", () => {
    const out = chooseHostChannelUser({
      invokerUid: 0,
      invokerName: "root",
      invokerHome: "/root",
      hasPasswordlessSudo: false,
    });
    expect(out).toEqual([
      {
        user: "root",
        authKeysPath: "/root/.ssh/authorized_keys",
        elevation: "login",
        source: "root",
      },
    ]);
  });

  it("follows root with $SUDO_USER, so a host that refuses root logins still gets a channel", () => {
    const out = chooseHostChannelUser({
      invokerUid: 0,
      invokerName: "root",
      invokerHome: "/root",
      hasPasswordlessSudo: false,
      sudoUser: { user: "admin", home: "/home/admin" },
    });
    // Order is the whole fix: root stays first (an operator who ran `sudo` asked for it,
    // and a working root install must not be migrated out from under them), and the
    // fallback is only ever reached when root's DIAL actually fails.
    expect(out.map((c) => c.user)).toEqual(["root", "admin"]);
    expect(out[1]).toEqual({
      user: "admin",
      // From the passwd database, never $HOME — sudo has already rewritten that to root's.
      authKeysPath: "/home/admin/.ssh/authorized_keys",
      elevation: "sudo",
      source: "sudo-user",
    });
  });

  it("ignores a SUDO_USER of root — that is not a second account", () => {
    const out = chooseHostChannelUser({
      invokerUid: 0,
      invokerName: "root",
      invokerHome: "/root",
      hasPasswordlessSudo: false,
      sudoUser: { user: "root", home: "/root" },
    });
    expect(out).toHaveLength(1);
  });

  it("offers ONLY the invoker on a non-root run, and elevates when sudo is passwordless", () => {
    const out = chooseHostChannelUser({
      invokerUid: 1000,
      invokerName: "ubuntu",
      invokerHome: "/home/ubuntu",
      hasPasswordlessSudo: true,
    });
    // The change #527 argued for: root is reached by ELEVATING this session, not by minting
    // a standing root SSH credential. No root candidate follows, because authorizing root's
    // file would mean writing an account we are not logging in as — the thing de-rooting
    // removed.
    expect(out).toEqual([
      {
        user: "ubuntu",
        authKeysPath: "/home/ubuntu/.ssh/authorized_keys",
        elevation: "sudo",
        source: "invoker",
      },
    ]);
  });

  it("flags the invoker as having no route to root when sudo isn't passwordless", () => {
    const out = chooseHostChannelUser({
      invokerUid: 1000,
      invokerName: "deploy",
      invokerHome: "/home/deploy",
      hasPasswordlessSudo: false,
    });
    expect(out).toEqual([
      {
        user: "deploy",
        authKeysPath: "/home/deploy/.ssh/authorized_keys",
        elevation: "none",
        source: "invoker",
      },
    ]);
  });

  it("honours a pin as the ONLY candidate — a fallback would defeat naming one", () => {
    const out = chooseHostChannelUser({
      invokerUid: 0,
      invokerName: "root",
      invokerHome: "/root",
      hasPasswordlessSudo: false,
      sudoUser: { user: "admin", home: "/home/admin" },
      pinned: { user: "ops", home: "/home/ops" },
    });
    expect(out).toEqual([
      {
        user: "ops",
        authKeysPath: "/home/ops/.ssh/authorized_keys",
        elevation: "sudo",
        source: "pin",
      },
    ]);
  });

  it("uses root's fixed path when root is what was pinned", () => {
    const out = chooseHostChannelUser({
      invokerUid: 1000,
      invokerName: "ubuntu",
      invokerHome: "/home/ubuntu",
      hasPasswordlessSudo: true,
      pinned: { user: "root", home: "/root" },
    });
    expect(out[0]).toMatchObject({
      user: "root",
      authKeysPath: "/root/.ssh/authorized_keys",
      elevation: "login",
    });
  });

  it("promotes the account the previous run settled on, so a re-run doesn't churn files", () => {
    const out = chooseHostChannelUser({
      invokerUid: 0,
      invokerName: "root",
      invokerHome: "/root",
      hasPasswordlessSudo: false,
      sudoUser: { user: "admin", home: "/home/admin" },
      carried: "admin",
      });
    // Continuity, not a pin: a box that already settled on `admin` shouldn't re-authorize
    // (and then revoke) root's file every run. It still falls through like any candidate.
    expect(out.map((c) => c.user)).toEqual(["admin", "root"]);
    expect(out[0]?.source).toBe("carried");
  });

  it("does not let a carried account invent a candidate we could not authorize", () => {
    const out = chooseHostChannelUser({
      invokerUid: 1000,
      invokerName: "ubuntu",
      invokerHome: "/home/ubuntu",
      hasPasswordlessSudo: true,
      // A previous root install, now re-run by a non-root user: root's authorized_keys is
      // not ours to write from here, so it must not reappear as a candidate.
      carried: "root",
    });
    expect(out.map((c) => c.user)).toEqual(["ubuntu"]);
  });
});

/**
 * `PermitRootLogin` admits our key for THREE of its four values, and the intuitive rule —
 * "anything but `yes` is a refusal" — is wrong twice over. Getting this backwards means
 * telling an operator to change a setting that was never the problem, on a box (default
 * Debian, which reports `without-password`) where root logins work fine.
 */
describe("sshdRefusesRootLogin", () => {
  it("treats every publickey-permitting value as permissive", () => {
    for (const value of ["yes", "prohibit-password", "without-password", "PROHIBIT-PASSWORD"]) {
      expect(sshdRefusesRootLogin(value), value).toBe(false);
    }
  });

  it("refuses on `no` and on forced-commands-only", () => {
    // forced-commands-only accepts the key and then kills the session, because our line
    // carries no `command=` — unusable, so it belongs on this side.
    expect(sshdRefusesRootLogin("no")).toBe(true);
    expect(sshdRefusesRootLogin("forced-commands-only")).toBe(true);
  });

  it("says nothing when sshd said nothing — an unread setting is not a refusal", () => {
    expect(sshdRefusesRootLogin(undefined)).toBe(false);
    expect(sshdRefusesRootLogin(null)).toBe(false);
    expect(sshdRefusesRootLogin("")).toBe(false);
  });
});

/**
 * #509, one layer along: `ssh-keygen` is the openssh CLIENT and `authorized_keys` is just
 * a file, so provisioning "succeeds" and writes all five OPENSHIP_HOST_* keys on a host
 * with no SSH SERVER at all. This is the prerequisite check, and a false negative here
 * would tell an operator their working host has no sshd — so it is read off a listing we
 * actually got, and matched on a whole address column.
 */
describe("listensOnPort", () => {
  const SS = [
    "LISTEN 0      4096         127.0.0.53%lo:53         0.0.0.0:*",
    "LISTEN 0      128                0.0.0.0:22         0.0.0.0:*",
    "LISTEN 0      128                   [::]:22            [::]:*",
  ].join("\n");

  const NETSTAT = [
    "Active Internet connections (only servers)",
    "Proto Recv-Q Send-Q Local Address           Foreign Address         State",
    "tcp        0      0 0.0.0.0:2222            0.0.0.0:*               LISTEN",
    "tcp6       0      0 :::80                   :::*                    LISTEN",
  ].join("\n");

  it("finds sshd in an `ss -ltn` listing, v4 or v6", () => {
    expect(listensOnPort(SS, 22)).toBe(true);
  });

  it("finds it in a `netstat -ltn` listing too", () => {
    expect(listensOnPort(NETSTAT, 2222)).toBe(true);
  });

  it("reports absent when nothing listens on that port", () => {
    expect(listensOnPort(SS, 2222)).toBe(false);
    expect(listensOnPort(NETSTAT, 22)).toBe(false);
    expect(listensOnPort("", 22)).toBe(false);
  });

  it("never lets :22 match :2222 (or the other way round)", () => {
    const only2222 = "LISTEN 0      128                0.0.0.0:2222       0.0.0.0:*";
    expect(listensOnPort(only2222, 22)).toBe(false);
    expect(listensOnPort(only2222, 2222)).toBe(true);
  });

  it("ignores rows that aren't listeners — a header, or an established connection", () => {
    const established = [
      "Proto Recv-Q Send-Q Local Address           Foreign Address         State",
      "tcp        0      0 10.0.0.5:51234          10.0.0.9:22             ESTABLISHED",
    ].join("\n");
    // An outbound ssh session is not a listening sshd, and reading it as one is how a
    // host with no server reports a healthy channel.
    expect(listensOnPort(established, 22)).toBe(false);
  });
});

/**
 * The reason a channel is missing exists ONLY at provisioning time: every later surface
 * (the install preflight, the API banner, the dashboard, `openship doctor`) sees an unset
 * OPENSHIP_HOST_SSH_HOST and can't tell a failed keygen from an operator who opted out.
 * So this warning is the whole account of the cause — and the framing around it comes
 * from @repo/core so it reads as the same story those surfaces tell.
 */
describe("renderHostChannelIssue", () => {
  const AT = { target: "host.docker.internal:22", kept: false };
  /** The message as one line: it is wrapped to 80 columns for a terminal, so asserting on
   *  any phrase longer than a few words otherwise depends on where the wrap happened to
   *  fall — which changes whenever a word before it does. */
  const unwrapped = (s: string) => s.replace(/\s+/g, " ");

  it("names the cause a later surface cannot recover", () => {
    const out = renderHostChannelIssue(
      { code: "keygen", detail: "ssh-keygen is not installed" },
      AT,
    );
    expect(out).toContain("could NOT be provisioned");
    expect(out).toContain("ssh-keygen is not installed");
  });

  it("says host operations refuse rather than target the container", () => {
    const out = renderHostChannelIssue({ code: "empty-key" }, AT);
    expect(out).toContain("OPENSHIP_HOST_SSH_HOST");
    expect(out).toContain("refuse");
  });

  it("says it KEPT the channel the install already had, when it did", () => {
    const out = renderHostChannelIssue({ code: "error", detail: "EACCES" }, { ...AT, kept: true });
    expect(out).toContain("Kept the host channel this install already had");
    // ...and does not also claim the keys are gone.
    expect(out).not.toContain("is therefore unset");
  });

  it("reports a missing SSH server as provisioned-but-unusable, with core's own remedy", () => {
    const out = renderHostChannelIssue({ code: "no-sshd", detail: "port 22" }, AT);
    expect(out).toContain("nothing on this host is listening for SSH");
    // The repair is core's refusal remedy, quoted rather than re-worded here — with the
    // unit name of the host mocked at the top of this file rather than a global default.
    expect(out).toContain("sudo systemctl enable --now ssh");
    expect(out).toContain("host.docker.internal:22");
    // The channel WAS written, so it must not claim the keys are unset or kept.
    expect(out).not.toContain("is therefore unset");
    expect(out).not.toContain("Kept the host channel");
  });

  it("names every account it dialed, not just the last one", () => {
    // #527's reporter was told only about `root`. On a sudo'd run we DID try their account
    // too, and an operator who can't see that reasonably asks why we didn't.
    const out = renderHostChannelIssue(
      {
        code: "auth-refused",
        detail: "Permission denied (publickey).",
        account: "admin",
        tried: ["root", "admin"],
      },
      AT,
    );
    expect(out).toContain("`root` then `admin`");
    expect(out).toContain("Permission denied (publickey).");
  });

  it("offers all three real remedies for a refusal, not just a re-run", () => {
    const out = renderHostChannelIssue({ code: "auth-refused", tried: ["root"] }, AT);
    expect(out).toContain("--host-ssh-user");
    expect(out).toContain("PermitRootLogin prohibit-password");
    expect(out).toContain("--no-host-control");
    // A refusal no longer leaves a channel behind, so it must say what happened to `.env`.
    expect(out).toContain("is therefore unset");
  });

  it("quotes sshd's PermitRootLogin only as an explanation, and only when it refuses", () => {
    const refusing = renderHostChannelIssue(
      { code: "auth-refused", tried: ["root"], permitRootLogin: "no" },
      AT,
    );
    expect(refusing).toContain("`PermitRootLogin no`");
    // Whitespace-normalized: the note is prose wrapped to the terminal, so any phrase long
    // enough to matter can land across a line break.
    expect(unwrapped(refusing)).toContain("refuses a root login outright");
    // `without-password` PERMITS publickey — the value is still reported, but claiming it
    // caused the refusal would send the operator to change a working setting.
    const permissive = renderHostChannelIssue(
      { code: "auth-refused", tried: ["root"], permitRootLogin: "without-password" },
      AT,
    );
    expect(permissive).toContain("`PermitRootLogin without-password`");
    expect(unwrapped(permissive)).not.toContain("refuses a root login outright");
  });

  it("reports a connect failure as an ADDRESS problem, never as a refused key", () => {
    const out = renderHostChannelIssue(
      { code: "unreachable", detail: "ssh: connect to host 127.0.0.1 port 22: Connection refused" },
      AT,
    );
    expect(out).toContain("ADDRESS problem, not a key problem");
    expect(out).toContain("ListenAddress");
    // The one thing it must never say: every non-zero `ssh` exit used to land here as a
    // refused key, which sent operators to an authorized_keys sshd had never read.
    expect(out).not.toContain("REFUSED the channel's key");
    // The channel WAS written, so no continuity claim either way.
    expect(out).not.toContain("is therefore unset");
    expect(out).not.toContain("Kept the host channel");
  });

  it("separates forced-commands-only, where the key was ACCEPTED", () => {
    const out = renderHostChannelIssue(
      { code: "forced-command", account: "root", detail: "Connection closed by 127.0.0.1" },
      AT,
    );
    expect(out).toContain("ACCEPTED the channel's key");
    expect(out).toContain("forced-commands-only");
    expect(out).not.toContain("REFUSED the channel's key");
    // A key that can't run a command is not a channel, so nothing was written — and unlike
    // the two host-level faults, this one has to say so.
    expect(out).toContain("is therefore unset");
  });

  it("always carries the reassurance, the blocked list and the re-check command", () => {
    // A degraded install is not a failed one, and an operator who reads only "host control
    // failed" tears down a box whose deploys were fine.
    for (const issue of [
      { code: "keygen" as const },
      { code: "empty-key" as const },
      { code: "error" as const },
      { code: "no-sshd" as const },
      { code: "auth-refused" as const, tried: ["root"] },
      { code: "unreachable" as const },
      { code: "forced-command" as const },
    ]) {
      const out = renderHostChannelIssue(issue, AT);
      expect(out, issue.code).toContain("Ordinary deploys to this box still work");
      expect(out, issue.code).toContain("the host terminal");
      expect(out, issue.code).toContain("installing or updating the mail engine");
      expect(out, issue.code).toContain("`openship doctor`");
    }
  });
});
