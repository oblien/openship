import { afterEach, describe, expect, it } from "vitest";

import {
  MAIL_CONTAINER_MOUNTS,
  MAIL_DB_DEFAULT_PORT,
  MAIL_DB_FALLBACK_PORT,
  MAIL_DB_PORT_RANGE_MAX,
  MAIL_DB_INTERNAL_PORT,
  MAIL_HOST_STATE_DIR,
  resolveMailDbPort,
} from "./mail-container";

const originalEnv = process.env.OPENSHIP_MAIL_DB_PORT;

afterEach(() => {
  if (originalEnv === undefined) {
    delete process.env.OPENSHIP_MAIL_DB_PORT;
  } else {
    process.env.OPENSHIP_MAIL_DB_PORT = originalEnv;
  }
});

describe("MAIL_CONTAINER_MOUNTS", () => {
  const byContainer = (path: string) => MAIL_CONTAINER_MOUNTS.find((m) => m.container === path);

  it("persists the mail logs across container recreates (issue #1701)", () => {
    // rsyslog writes mail.log, dovecot/*.log and fail2ban.log to /var/log, and
    // supervisord writes its per-program logs to /var/log/supervisor — none of
    // it reaches `docker logs`, so a recreate on an ephemeral layer loses it.
    const mount = byContainer("/var/log");
    expect(mount).toBeDefined();
    expect(mount?.host).toBe(`${MAIL_HOST_STATE_DIR}/logs`);
    // Pure data — nothing to seed; the entrypoint pre-creates the files it needs.
    expect(mount?.seed).toBeFalsy();
  });

  it("persists fail2ban's own ban database across container recreates (issue #1701)", () => {
    // The SQLite database fail2ban restores bans from (default
    // /var/lib/fail2ban/fail2ban.sqlite3) — without this mount every update
    // starts from an empty database ("New database created").
    const mount = byContainer("/var/lib/fail2ban");
    expect(mount).toBeDefined();
    expect(mount?.host).toBe(`${MAIL_HOST_STATE_DIR}/fail2ban`);
    expect(mount?.seed).toBeFalsy();
  });

  it("does not bind-mount /etc/fail2ban wholesale (issue #1701)", () => {
    // The entrypoint rewrites files there on every boot, and a seed-once mount
    // would hide later image changes — the same trap as #392's bind-mounted
    // master.cf. Operator ignoreip goes through OPENSHIP_MAIL_F2B_IGNOREIP,
    // rendered into a jail.d override by the entrypoint, instead.
    expect(byContainer("/etc/fail2ban")).toBeUndefined();
  });
});

describe("resolveMailDbPort", () => {
  it("defaults to 5432 when no argument or env var is present", () => {
    delete process.env.OPENSHIP_MAIL_DB_PORT;
    expect(resolveMailDbPort()).toBe(5432);
    expect(resolveMailDbPort(undefined)).toBe(5432);
    expect(resolveMailDbPort("")).toBe(5432);
  });

  it("reads from OPENSHIP_MAIL_DB_PORT environment variable", () => {
    process.env.OPENSHIP_MAIL_DB_PORT = "5433";
    expect(resolveMailDbPort()).toBe(5433);
  });

  it("parses valid port numbers and strings", () => {
    expect(resolveMailDbPort("5433")).toBe(5433);
    expect(resolveMailDbPort(" 5434 ")).toBe(5434);
    expect(resolveMailDbPort(5435)).toBe(5435);
    expect(resolveMailDbPort(1)).toBe(1);
    expect(resolveMailDbPort(65535)).toBe(65535);
  });

  it.each(["0", "-1", "65536", "not-a-port", "5432.5", "0x1538", "5e3", " "])(
    "refuses an invalid explicit port %s",
    (value) => expect(() => resolveMailDbPort(value)).toThrow(/between 1 and 65535/),
  );

  it("exports matching internal and default port constants", () => {
    expect(MAIL_DB_DEFAULT_PORT).toBe(5432);
    expect(MAIL_DB_INTERNAL_PORT).toBe(5432);
    expect(MAIL_DB_FALLBACK_PORT).toBe(5433);
    expect(MAIL_DB_PORT_RANGE_MAX).toBe(5460);
  });
});
