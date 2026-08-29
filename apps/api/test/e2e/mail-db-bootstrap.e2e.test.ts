/**
 * The mail engine's DB bootstrap, against a REAL PostgreSQL sidecar (GH-562).
 *
 * The bug this exists for could not be caught by any unit test, because the defect
 * was the script's *failure semantics* rather than its SQL. `db-bootstrap.sh` ran
 * under `set -uo pipefail` with no `-e`, so when it started before the sidecar was
 * ready every psql failed in turn, the script reached its closing
 * "── DB bootstrap complete ──" and exited 0. The caller's `|| log "ERROR"` could
 * therefore never fire. Operators saw dovecot, iredapd and amavis crash-loop against
 * an empty database with nothing anywhere explaining why, and the only recovery was
 * to run the script by hand.
 *
 * A second, quieter variant: `doveadm pw` ran with `2>/dev/null` and its output
 * unvalidated, so a missing `doveadm` seeded the postmaster with an EMPTY password
 * and still reported success.
 *
 * What this asserts is therefore mostly about EXIT CODES and the absence of false
 * success — the three cases below all passed (exit 0) before the fix.
 *
 * Why not boot `openship-mail` itself: that image is not published, and building it
 * runs the full iRedMail installer — minutes to tens of minutes, which is not a test.
 * The script's real collaborators are bash, psql, perl and the engine's SQL samples,
 * so a Debian `postgres:16` runner with the repo's actual `engine/samples` copied in
 * exercises the real script against a real database. `doveadm` is the one collaborator
 * that must be stubbed, and stubbing it is what lets us drive its failure mode
 * deliberately. The Dockerfile smoke gate covers doveadm's real presence.
 *
 * Files travel by `docker cp`, not a bind mount: a mount only works when the daemon
 * can see the host path, which is false for a macOS temp dir under Colima and true in
 * CI — i.e. the one setup where a gate must not evaporate. Same reasoning as
 * edge-not-found-page.e2e.test.ts.
 *
 * Skips without a reachable daemon, FAILS under RUN_DOCKER_E2E=1 (what CI sets).
 * See test/helpers/docker-e2e.ts.
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describeDockerE2E, requireDocker } from "../helpers/docker-e2e";

const execFileAsync = promisify(execFile);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const EMAIL_DIR = join(REPO_ROOT, "apps/email");

/** Unique per run so a leftover container from a killed run can't collide. */
const SUFFIX = process.pid.toString(36);
const NET = `openship-e2e-mailboot-${SUFFIX}`;
const DB = `openship-e2e-mailboot-db-${SUFFIX}`;
const RUNNER = `openship-e2e-mailboot-run-${SUFFIX}`;

const DB_IMAGE = "postgres:16-alpine";
/** Debian-based: the script is bash and uses perl for iRedMail's PH_ substitutions. */
const RUNNER_IMAGE = "postgres:16";

const PG_PASSWORD = "e2e-root-pw";
const BIND_PASSWORD = "e2e-bind-pw";
const POSTMASTER_PLAIN = "e2e-postmaster-pw";
const FIRST_DOMAIN = "e2e-mail.example";
/** Any well-formed SSHA512 value; the script only validates the shape. */
const STUB_HASH = "{SSHA512}ZTJlLXN0dWItaGFzaC12YWx1ZQ==";

const SCRIPT_IN_RUNNER = "/opt/openship-mail/db-bootstrap.sh";

async function docker(args: string[], opts: { allowFail?: boolean } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync("docker", args, {
      maxBuffer: 32 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
    if (!opts.allowFail) {
      throw new Error(
        `docker ${args.slice(0, 3).join(" ")} failed: ${e.stderr || e.message || "unknown"}`,
      );
    }
    return { code: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

/** Run db-bootstrap.sh in the runner. Never throws — the exit code IS the assertion. */
async function runBootstrap(env: Record<string, string> = {}) {
  const envArgs = Object.entries({
    FIRST_DOMAIN,
    VMAIL_DB_BIND_PASSWD: BIND_PASSWORD,
    DOMAIN_ADMIN_PASSWD_PLAIN: POSTMASTER_PLAIN,
    PGSQL_ROOT_PASSWD: PG_PASSWORD,
    OPENSHIP_MAIL_DB_HOST: DB,
    OPENSHIP_MAIL_DB_PORT: "5432",
    ...env,
  }).flatMap(([k, v]) => ["--env", `${k}=${v}`]);

  const r = await docker(
    ["exec", ...envArgs, RUNNER, "bash", SCRIPT_IN_RUNNER],
    { allowFail: true },
  );
  return { ...r, log: `${r.stdout}\n${r.stderr}` };
}

/** A one-shot query as the postgres superuser, from inside the runner. */
async function query(sql: string, db = "vmail"): Promise<string> {
  const r = await docker([
    "exec",
    "--env", `PGPASSWORD=${PG_PASSWORD}`,
    RUNNER,
    "psql", "-h", DB, "-U", "postgres", "-d", db, "-tAc", sql,
  ]);
  return r.stdout.trim();
}

/**
 * Replace the stubbed `doveadm` so its failure mode can be driven deliberately.
 *
 * `%b`, not `%s`: printf only interprets `\n` in the FORMAT for %b, so `%s` wrote the
 * two-character sequence and produced a one-line file that is not a runnable script.
 * That silently turned every case into the "doveadm is broken" case.
 */
async function setDoveadmStub(body: string): Promise<void> {
  await docker([
    "exec", RUNNER, "bash", "-c",
    `printf '%b\\n' ${JSON.stringify(body)} > /usr/bin/doveadm && chmod +x /usr/bin/doveadm`,
  ]);
  // Prove the stub is executable and behaves, so a broken stub can never masquerade
  // as a finding about the script under test.
  await docker(["exec", RUNNER, "/usr/bin/doveadm", "pw", "-s", "SSHA512", "-p", "x"], {
    allowFail: true,
  });
}

describeDockerE2E("mail engine DB bootstrap (real postgres)", () => {
  beforeAll(async () => {
    await requireDocker();

    await docker(["network", "create", NET]);

    // vmail is PRE-CREATED here exactly as the real sidecar does it (POSTGRES_DB),
    // because the script loads schema into it rather than creating it.
    await docker([
      "run", "-d", "--name", DB, "--network", NET,
      "--env", `POSTGRES_PASSWORD=${PG_PASSWORD}`,
      "--env", "POSTGRES_DB=vmail",
      DB_IMAGE,
    ]);

    await docker([
      "run", "-d", "--name", RUNNER, "--network", NET,
      "--entrypoint", "sleep", RUNNER_IMAGE, "3600",
    ]);

    // The REAL script and the REAL iRedMail SQL samples.
    await docker(["exec", RUNNER, "mkdir", "-p", "/opt/openship-mail", "/opt/iRedMail-engine"]);
    await docker(["cp", join(EMAIL_DIR, "docker/db-bootstrap.sh"), `${RUNNER}:${SCRIPT_IN_RUNNER}`]);
    await docker(["cp", join(EMAIL_DIR, "engine/samples"), `${RUNNER}:/opt/iRedMail-engine/samples`]);

    await setDoveadmStub(`#!/bin/sh\necho '${STUB_HASH}'`);
  }, 300_000);

  afterAll(async () => {
    await docker(["rm", "-f", RUNNER], { allowFail: true });
    await docker(["rm", "-f", DB], { allowFail: true });
    await docker(["network", "rm", NET], { allowFail: true });
  }, 120_000);

  // Ordered on purpose: each case leaves the database in the state the next expects,
  // and the doveadm case must run while the schema is still absent.
  it("waits for a database that is not ready yet instead of failing against it", async () => {
    // The runner and the sidecar started together, so this first call races postgres's
    // own initdb — which is the GH-562 race, reproduced rather than simulated. The old
    // `nc -z` probe returned as soon as the port bound and the bootstrap proceeded.
    // Nothing is asserted about timing; the point is that it SUCCEEDS below.
    const r = await runBootstrap();
    expect(r.log).toMatch(/waiting for the mail database|mail database answered|bootstrapping/i);
    expect(r.code).toBe(0);
  }, 300_000);

  it("seeded the first domain and a postmaster with a NON-EMPTY password", async () => {
    expect(await query("SELECT count(*) FROM domain")).toBe("1");
    expect(await query("SELECT domain FROM domain LIMIT 1")).toBe(FIRST_DOMAIN);

    // The whole point of the hash validation: this column must never be blank.
    const blank = await query(
      `SELECT count(*) FROM mailbox WHERE coalesce(password,'') = ''`,
    );
    expect(blank).toBe("0");
    expect(await query(`SELECT password FROM mailbox WHERE username = 'postmaster@${FIRST_DOMAIN}'`))
      .toBe(STUB_HASH);
  }, 60_000);

  it("is idempotent: a second run skips instead of re-seeding", async () => {
    const r = await runBootstrap();
    expect(r.code).toBe(0);
    expect(r.log).toMatch(/already present — skipping/i);
    expect(await query("SELECT count(*) FROM domain")).toBe("1");
  }, 120_000);

  it("FAILS instead of reporting success when doveadm produces nothing", async () => {
    // Reproduces a mail image without doveadm. Before the fix this seeded an empty
    // password and exited 0; the operator learned about it when auth silently failed.
    await setDoveadmStub("#!/bin/sh\nexit 127");
    try {
      // Drop the gate so the run gets past the idempotency check to the hash step.
      await docker(["exec", "--env", `PGPASSWORD=${PG_PASSWORD}`, RUNNER,
        "psql", "-h", DB, "-U", "postgres", "-d", "vmail", "-c", "DROP TABLE mailbox CASCADE"]);

      const r = await runBootstrap();

      expect(r.code).not.toBe(0);
      expect(r.log).toMatch(/doveadm pw produced no output|is doveadm installed/i);
      // And it must not have claimed success on the way out.
      expect(r.log).not.toMatch(/DB bootstrap complete/);
    } finally {
      await setDoveadmStub(`#!/bin/sh\necho '${STUB_HASH}'`);
    }
  }, 180_000);

  it("FAILS with a diagnosable message when the database never answers", async () => {
    const r = await runBootstrap({
      // TEST-NET-3 drops rather than refuses, which is the realistic bad case (a
      // firewall, a wrong host). It is also the case that proves PGCONNECT_TIMEOUT is
      // doing its job: without it libpq blocks for the OS default and the wait budget
      // below never gets a second iteration.
      OPENSHIP_MAIL_DB_HOST: "203.0.113.1",
      OPENSHIP_MAIL_DB_WAIT_SECS: "4",
      PGCONNECT_TIMEOUT: "2",
    });

    expect(r.code).not.toBe(0);
    expect(r.log).toMatch(/did not accept queries within 4s/);
    // The message has to point somewhere. A bare "failed" is what made this a
    // multi-hour hunt in the field.
    expect(r.log).toMatch(/docker logs openship-mail-db/);
    expect(r.log).not.toMatch(/DB bootstrap complete/);
  }, 180_000);

  it("negative control: the harness can still observe a failing script", async () => {
    // A container test that quietly stopped running the script would look exactly
    // like a passing one. Prove a non-zero exit is actually detected.
    const r = await docker(["exec", RUNNER, "bash", "-c", "exit 3"], { allowFail: true });
    expect(r.code).toBe(3);
  }, 60_000);
});
