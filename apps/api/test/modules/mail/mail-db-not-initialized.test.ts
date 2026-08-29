import "./_setup-env";

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * An unseeded `vmail` must fail TYPED, with the fix in the message.
 *
 * The other half of GH-562: `db-bootstrap.sh` could exit 0 without having loaded the
 * schema, leaving a box that serves SSH, runs the engine container, and answers every
 * admin read with `relation "domain" does not exist`. That reached the panel as a bare
 * 500 — "API 500" with no cause and no next step — because `runMailCommand` only
 * re-types wrong-topology signatures and a missing relation matches none of them.
 *
 * Asserting on the STATUS and the MESSAGE, not on rows: the remediation text is the
 * deliverable, since the dashboard renders `body.error` verbatim.
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
import {
  forgetMailEngine,
  runMailSql,
  MailDbNotInitializedError,
} from "../../../src/modules/mail/mail-engine";

const CONTAINER = {
  flavor: "container" as const,
  running: true,
  exists: true,
  image: "ghcr.io/oblien/openship-mail:0.6.5",
};
const HOST = { flavor: "host" as const, running: true, exists: true, image: null };

/** An executor whose psql always rejects with `stderr`, as the SSH layer does. */
function failing(stderr: string) {
  const exec = {
    exec: vi.fn(async () => {
      throw new Error(stderr);
    }),
  } as never;
  // The topology memo is keyed by executor; a fresh object per case still needs the
  // probe seeded, since forgetMailEngine only drops a cached answer.
  forgetMailEngine(exec);
  return exec;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(detectMailEngine).mockResolvedValue(CONTAINER);
});

describe("runMailSql — unseeded schema", () => {
  it("types a missing table as 409 with the bootstrap command", async () => {
    const exec = failing('ERROR:  relation "domain" does not exist\nLINE 1: SELECT ...');

    const err = await runMailSql(exec, "SELECT count(*) FROM domain").catch((e) => e);

    expect(err).toBeInstanceOf(MailDbNotInitializedError);
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe("MAIL_DB_NOT_INITIALIZED");
    expect(err.message).toContain("db-bootstrap.sh");
    // The daemons are already FATAL against the empty database by this point, and
    // supervisord never retries that — the schema alone does not revive them.
    expect(err.message).toContain("docker restart openship-mail");
    // Must not read as a verdict while setup may still be mid-bootstrap.
    expect(err.message).toContain("still running");
  });

  it("types a missing database the same way", async () => {
    const exec = failing('psql: FATAL:  database "vmail" does not exist');

    const err = await runMailSql(exec, "SELECT 1").catch((e) => e);

    expect(err).toBeInstanceOf(MailDbNotInitializedError);
    expect(err.code).toBe("MAIL_DB_NOT_INITIALIZED");
  });

  it("points a legacy host box at mail setup, not at a docker command", async () => {
    vi.mocked(detectMailEngine).mockResolvedValue(HOST);
    const exec = failing('ERROR:  relation "mailbox" does not exist');

    const err = await runMailSql(exec, "SELECT 1").catch((e) => e);

    expect(err).toBeInstanceOf(MailDbNotInitializedError);
    expect(err.message).toContain("Re-run mail setup");
    expect(err.message).not.toContain("docker");
  });

  /**
   * `column … does not exist` means OUR SQL disagrees with a schema that IS there.
   * That is our bug to read verbatim, not an operator's to bootstrap away — and
   * dressing it up as "no schema" would send them to run a command that fixes nothing.
   */
  it("leaves a schema mismatch as the raw error", async () => {
    const exec = failing('ERROR:  column "nonesuch" does not exist');

    const err = await runMailSql(exec, "SELECT nonesuch FROM domain").catch((e) => e);

    expect(err).not.toBeInstanceOf(MailDbNotInitializedError);
    expect(err.message).toContain('column "nonesuch" does not exist');
  });

  it("leaves an unrelated psql failure alone", async () => {
    const exec = failing("psql: error: connection to server failed: Connection refused");

    const err = await runMailSql(exec, "SELECT 1").catch((e) => e);

    expect(err).not.toBeInstanceOf(MailDbNotInitializedError);
    expect(err.message).toContain("Connection refused");
  });
});
