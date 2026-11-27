import "./_setup-env";

import { beforeEach, describe, expect, it, vi } from "vitest";

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
import { hashPassword } from "@repo/platform/engine/modules/mail/admin/password";
import {
  createMaildirOnDisk,
  generateMaildir,
  removeMaildirOnDisk,
} from "@repo/platform/engine/modules/mail/admin/maildir";
import { forgetMailEngine } from "@repo/platform/engine/modules/mail/mail-engine";

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

it("generates a fresh Dovecot salt for each mailbox password", () => {
  const first = hashPassword("fixture-password");
  expect(first).toMatch(/^\{SSHA512\}/);
  expect(hashPassword("fixture-password")).not.toBe(first);
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

    expect(r.last()).toContain("chown vmail:vmail");
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

    expect(r.last()).toMatch(/^docker exec openship-mail sh -c /);
    expect(r.last()).toContain("realpath -m --");
    expect(r.last()).toContain("rm -rf --");
    expect(r.last()).toContain(`/var/vmail/vmail1/${layout.maildir.slice(0, -1)}`);
  });

  it("confines a shared mailbox to its reserved domain and an individual home", async () => {
    const r = recorder("");
    const layout = generateMaildir("first.test", ".team");
    expect(layout.maildir.split("/")).not.toContain(".");
    for (const maildir of ["second.test/me/", "first.test/", "first.test/../me/", "first.test//me/"]) {
      await expect(removeMaildirOnDisk(r.exec as never, { ...layout, maildir }, "first.test"))
        .rejects.toThrow("outside");
    }
    expect(r.calls).toHaveLength(0);
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
    ).rejects.toThrow(/Refusing maildir outside/);
    expect(r.calls).toHaveLength(0);
  });
});
