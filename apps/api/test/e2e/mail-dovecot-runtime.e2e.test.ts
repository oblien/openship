import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import { shellQuote as sq } from "@repo/core";
import { describeDockerE2E, requireDocker } from "../helpers/docker-e2e";

const exec = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const RUNNER = `openship-e2e-dovecot-${process.pid.toString(36)}`;
const PREPARE = "bash /prepare-dovecot-runtime.sh";
// The production mail image uses Debian 12's Dovecot. Install those real
// collaborators without a full iRedMail build or a published Openship image.
const CONFIG = `protocols = imap pop3
listen = 127.0.0.1
ssl = no
disable_plaintext_auth = no
mail_location = maildir:/tmp/dovecot-test-mail
log_path = /dovecot-test.log
info_log_path = /dovecot-test.log
passdb {
  driver = static
  args = password=test
}
userdb {
  driver = static
  args = uid=nobody gid=nogroup home=/tmp/dovecot-test-mail
}
`;

async function docker(args: string[], allowFail = false) {
  try {
    const { stdout, stderr } = await exec("docker", args, {
      timeout: 180_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    if (!allowFail) throw error;
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}
const run = (script: string, allowFail = false) =>
  docker(["exec", RUNNER, "bash", "-euo", "pipefail", "-c", script], allowFail);

describeDockerE2E("Dovecot startup after container restart (issue #1700)", () => {
  beforeAll(async () => {
    await requireDocker();
    await docker(["pull", "debian:12-slim"]);
    await docker(["run", "-d", "--name", RUNNER, "debian:12-slim", "sleep", "1800"]);
    await docker(["exec", RUNNER, "apt-get", "update"]);
    await docker([
      "exec",
      "--env",
      "DEBIAN_FRONTEND=noninteractive",
      RUNNER,
      "apt-get",
      "install",
      "-y",
      "--no-install-recommends",
      "dovecot-core",
      "dovecot-imapd",
      "dovecot-pop3d",
      "netcat-openbsd",
    ]);
    // From here, the daemon has only loopback. No mail is delivered or exposed.
    await docker(["network", "disconnect", "bridge", RUNNER]);
    await docker([
      "cp",
      join(ROOT, "apps/email/docker/prepare-dovecot-runtime.sh"),
      `${RUNNER}:/prepare-dovecot-runtime.sh`,
    ]);
    await run(`printf %s ${sq(CONFIG)} > /dovecot-test.conf
      ${PREPARE}`);
  });
  afterAll(async () => {
    await docker(["rm", "-f", RUNNER], true);
  });

  it("removes a stale PID naming another live process and restores IMAP/POP3", async () => {
    await run(`install -d /var/run/dovecot
      sh -c 'echo $$ > /var/run/dovecot/master.pid; exec sleep 120' >/unrelated.log 2>&1 &
      for attempt in $(seq 1 30); do
        if [ -s /var/run/dovecot/master.pid ]; then break; fi
        sleep 0.1
      done
      cp /var/run/dovecot/master.pid /unrelated.pid
      kill -0 "$(cat /unrelated.pid)"`);
    const stale = await run("timeout 5 dovecot -c /dovecot-test.conf -F", true);
    expect(stale.code).not.toBe(0);
    expect(stale.code).not.toBe(124);
    expect(stale.stdout + stale.stderr).toMatch(/already running/i);

    await run(`${PREPARE}
      test ! -e /var/run/dovecot/master.pid
      kill -0 "$(cat /unrelated.pid)"
      dovecot -c /dovecot-test.conf -F >/dovecot.log 2>&1 &
      daemon_pid=$!
      trap 'kill "$daemon_pid" "$(cat /unrelated.pid)" 2>/dev/null || true; wait "$daemon_pid" 2>/dev/null || true' EXIT
      for attempt in $(seq 1 50); do
        if nc -z -w 1 127.0.0.1 143 && nc -z -w 1 127.0.0.1 110; then break; fi
        sleep 0.1
      done
      printf '' | nc -w 3 127.0.0.1 143 > /imap.log
      grep -q '^\\* OK' /imap.log
      printf '' | nc -w 3 127.0.0.1 110 > /pop3.log
      grep -q '^+OK' /pop3.log`);
  });

  it("clears the stale PID across a real restart and stays idempotent", async () => {
    await run(`install -d /var/run/dovecot
      sh -c 'echo $$ > /var/run/dovecot/master.pid; exec sleep 120' >/unrelated2.log 2>&1 &
      for attempt in $(seq 1 30); do
        if [ -s /var/run/dovecot/master.pid ]; then break; fi
        sleep 0.1
      done
      cp /var/run/dovecot/master.pid /unrelated2.pid
      kill -0 "$(cat /unrelated2.pid)"`);
    // The writable layer survives a real restart. The runtime preparer is the
    // same script the production entrypoint runs before starting supervisord.
    await docker(["restart", RUNNER]);
    await run(`${PREPARE}
      test ! -e /var/run/dovecot/master.pid
      ${PREPARE}
      test ! -e /var/run/dovecot/master.pid
      dovecot -c /dovecot-test.conf -F >/dovecot2.log 2>&1 &
      daemon_pid=$!
      trap 'kill "$daemon_pid" 2>/dev/null || true; wait "$daemon_pid" 2>/dev/null || true' EXIT
      for attempt in $(seq 1 50); do
        if nc -z -w 1 127.0.0.1 143 && nc -z -w 1 127.0.0.1 110; then break; fi
        sleep 0.1
      done
      printf '' | nc -w 3 127.0.0.1 143 > /imap2.log
      grep -q '^\\* OK' /imap2.log
      printf '' | nc -w 3 127.0.0.1 110 > /pop3-2.log
      grep -q '^+OK' /pop3-2.log`);
  });
});
