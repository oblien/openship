import "./_setup-env";

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The mailbox-creation path must reach the mail engine, not the host (GH-562).
 *
 * `doveadm` and the `vmail` user live wherever Dovecot does. On a container-flavor
 * box that is INSIDE `openship-mail` and emphatically not on the host — yet
 * `hashPassword` ran a bare `doveadm pw` and `createMaildirOnDisk` ran a bare
 * `chown -R vmail:vmail`, both straight against the host executor. The result was a
 * 500 on every mailbox create on a containerized install: no `doveadm` on the host
 * meant empty output, and the SSHA512 gate rejected it.
 *
 * Every existing test in this directory hands these helpers a `vi.fn()` executor and
 * asserts on the ROWS, so all of them stayed green while the command that produced
 * those rows could not run anywhere. The assertions here are deliberately on the
 * COMMAND STRING, because the prefix is the entire bug.
 *
 * These run on every PR — no daemon needed. The companion real-Docker case is
 * test/e2e/mail-db-bootstrap.e2e.test.ts, which covers the other half of GH-562.
 */

vi.mock("@repo/adapters", () => ({
  HOST_STATE_DIR: "/root/.openship",
  detectMailEngine: vi.fn(),
  MAIL_CONTAINER: "openship-mail",
  MAIL_DB_CONTAINER: "openship-mail-db",
  MAIL_DB_NAME: "vmail",
  MAIL_HOST_PATHS: {
    saslPasswd: "/opt/openship/mail/postfix/sasl_passwd",
    senderRelayhost: "/opt/openship/mail/postfix/sender_relayhost",
    amavisUserConf: "/opt/openship/mail/amavis/50-user",
  },
}));

import { detectMailEngine } from "@repo/adapters";
import { hashPassword } from "../../../src/modules/mail/admin/password";
import {
  createMaildirOnDisk,
  generateMaildir,
  removeMaildirOnDisk,
} from "../../../src/modules/mail/admin/maildir";
import { forgetMailEngine } from "../../../src/modules/mail/mail-engine";

const HASH = "{SSHA512}c2FsdGVkaGFzaHZhbHVl";

const CONTAINER = {
  flavor: "container" as const,
  running: true,
  exists: true,
  image: "ghcr.io/oblien/openship-mail:0.6.5",
};
const HOST = { flavor: "host" as const, running: true, exists: true, image: null };

/** An executor that records every command and answers with `reply`. */
function recorder(reply: string) {
  const calls: string[] = [];
  const exec = {
    exec: vi.fn(async (cmd: string) => {
      calls.push(cmd);
      return reply;
    }),
  };
  forgetMailEngine(exec as never);
  return { exec, calls, last: () => calls[calls.length - 1] ?? "" };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("hashPassword transport", () => {
  it("runs doveadm INSIDE the engine on a container-flavor box", async () => {
    vi.mocked(detectMailEngine).mockResolvedValue(CONTAINER);
    const r = recorder(HASH);

    await expect(hashPassword(r.exec as never, "sekrit-pw")).resolves.toBe(HASH);

    // The prefix IS the fix. Without it the host answers, and the host has no doveadm.
    expect(r.last()).toContain("docker exec openship-mail ");
    expect(r.last()).toContain("doveadm pw -s SSHA512");
  });

  it("runs doveadm bare on a legacy host-flavor box", async () => {
    vi.mocked(detectMailEngine).mockResolvedValue(HOST);
    const r = recorder(HASH);

    await expect(hashPassword(r.exec as never, "sekrit-pw")).resolves.toBe(HASH);

    expect(r.last()).not.toContain("docker exec");
    expect(r.last()).toContain("doveadm pw -s SSHA512");
  });

  it("keeps the plaintext out of the thrown message when doveadm answers nothing", async () => {
    vi.mocked(detectMailEngine).mockResolvedValue(CONTAINER);
    const r = recorder("");

    // The empty-output case is exactly what a missing doveadm produced, and the
    // operator saw only "500 Internal Server Error" for it.
    await expect(hashPassword(r.exec as never, "sekrit-pw")).rejects.toThrow(/empty output/);
    await expect(hashPassword(r.exec as never, "sekrit-pw")).rejects.not.toThrow(/sekrit-pw/);
  });

  it("names the engine flavor in the failure, so the reader knows which box answered", async () => {
    vi.mocked(detectMailEngine).mockResolvedValue(CONTAINER);
    const r = recorder("doveadm: command not found");

    await expect(hashPassword(r.exec as never, "pw")).rejects.toThrow(/container engine/);
  });
});

describe("createMaildirOnDisk transport + layout", () => {
  it("creates the tree Dovecot actually opens: <home>/Maildir/{cur,new,tmp}", async () => {
    vi.mocked(detectMailEngine).mockResolvedValue(CONTAINER);
    const r = recorder("");
    const layout = generateMaildir("acme.com", "alice", new Date("2026-01-02T03:04:05Z"));

    await createMaildirOnDisk(r.exec as never, layout);
    const cmd = r.last();

    // mail_location = maildir:%Lh/Maildir/ (engine/samples/dovecot/dovecot.conf:64),
    // with home = <base>/<node>/<maildir>. A tree at <home>/cur is one level shallow
    // and Dovecot never reads it.
    const home = `/var/vmail/vmail1/${layout.maildir}`;
    expect(cmd).toContain(`${home}Maildir/cur`);
    expect(cmd).toContain(`${home}Maildir/new`);
    expect(cmd).toContain(`${home}Maildir/tmp`);
    expect(cmd).not.toContain(`'${home}cur'`);
  });

  it("wraps the compound command in one sh -c so && cannot leak to the host shell", async () => {
    vi.mocked(detectMailEngine).mockResolvedValue(CONTAINER);
    const r = recorder("");

    await createMaildirOnDisk(r.exec as never, generateMaildir("acme.com", "bob"));
    const cmd = r.last();

    // `docker exec <c> a && b` would run `a` in the engine and `b` on the HOST —
    // which is how a chown meant for the engine's vmail user hits a host without one.
    expect(cmd).toMatch(/^docker exec openship-mail sh -c /);
    const afterShC = cmd.slice(cmd.indexOf("sh -c "));
    expect(afterShC.startsWith("sh -c '")).toBe(true);
    // Every && must sit INSIDE the quoted script, never between top-level words.
    expect(cmd.replace(/'.*'/s, "''")).not.toContain("&&");
  });

  it("chowns to vmail INSIDE the engine, where that user exists", async () => {
    vi.mocked(detectMailEngine).mockResolvedValue(CONTAINER);
    const r = recorder("");

    await createMaildirOnDisk(r.exec as never, generateMaildir("acme.com", "carol"));

    expect(r.last()).toContain("chown -R vmail:vmail");
    expect(r.last()).toMatch(/^docker exec openship-mail /);
  });

  it("stays bare on a legacy host-flavor box", async () => {
    vi.mocked(detectMailEngine).mockResolvedValue(HOST);
    const r = recorder("");

    await createMaildirOnDisk(r.exec as never, generateMaildir("acme.com", "dave"));

    expect(r.last()).not.toContain("docker exec");
    expect(r.last()).toMatch(/^sh -c /);
  });
});

describe("removeMaildirOnDisk", () => {
  it("removes the home through the engine, covering the Maildir subtree", async () => {
    vi.mocked(detectMailEngine).mockResolvedValue(CONTAINER);
    const r = recorder("");
    const layout = generateMaildir("acme.com", "erin");

    await removeMaildirOnDisk(r.exec as never, layout);

    expect(r.last()).toBe(
      `docker exec openship-mail rm -rf '/var/vmail/vmail1/${layout.maildir}'`,
    );
  });

  it("still refuses a path outside /var/vmail before any command is built", async () => {
    vi.mocked(detectMailEngine).mockResolvedValue(CONTAINER);
    const r = recorder("");

    await expect(
      removeMaildirOnDisk(r.exec as never, {
        storagebasedirectory: "/etc",
        storagenode: "passwd",
        maildir: "",
      }),
    ).rejects.toThrow(/Refusing to remove maildir outside/);
    expect(r.calls).toHaveLength(0);
  });
});
