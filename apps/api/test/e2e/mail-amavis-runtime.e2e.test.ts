import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import { shellQuote as sq } from "@repo/core";
import { describeDockerE2E, requireDocker } from "../helpers/docker-e2e";

const exec = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const RUNNER = `openship-e2e-amavis-${process.pid.toString(36)}`;
const PREPARE = "bash /prepare-amavis-runtime.sh";
// The production mail image uses Debian 12's Amavis. Install those real
// collaborators without a full iRedMail build or a published Openship image.
const CONFIG = `use strict;
$mydomain = 'example.test';
$myhostname = 'mail.example.test';
$daemon_user = 'amavis';
$daemon_group = 'amavis';
$MYHOME = '/var/lib/amavis';
$TEMPBASE = "$MYHOME/tmp";
$pid_file = '/var/run/amavis/amavisd.pid';
$lock_file = '/var/run/amavis/amavisd.lock';
$unix_socketname = '/var/run/amavis/amavisd.socket';
$inet_socket_bind = '127.0.0.1';
$inet_socket_port = [10024,10026];
@inet_acl = qw(127.0.0.1);
@local_domains_maps = (1);
@bypass_virus_checks_maps = (1);
@bypass_spam_checks_maps = (1);
$forward_method = undef;
$notify_method = undef;
$do_syslog = 0;
$log_level = 1;
$max_servers = 1;
1;
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

describeDockerE2E("Amavis startup after container restart (PR #885)", () => {
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
      "amavisd-new",
      "netcat-openbsd",
    ]);
    // From here, the daemon has only loopback. No mail is delivered or exposed.
    await docker(["network", "disconnect", "bridge", RUNNER]);
    await docker([
      "cp",
      join(ROOT, "apps/email/docker/prepare-amavis-runtime.sh"),
      `${RUNNER}:/prepare-amavis-runtime.sh`,
    ]);
    await run(`printf %s ${sq(CONFIG)} > /amavis-test.conf
      install -d -m 0750 -o amavis -g amavis /var/lib/amavis/tmp
      ${PREPARE}`);
  });
  afterAll(async () => {
    await docker(["rm", "-f", RUNNER], true);
  });

  it("removes a stale PID naming another live process and restores both SMTP listeners", async () => {
    await run(`runuser -u amavis -- sh -c 'echo $$ > /var/run/amavis/amavisd.pid; exec sleep 120' >/unrelated.log 2>&1 &
      for attempt in $(seq 1 30); do
        if [ -s /var/run/amavis/amavisd.pid ]; then break; fi
        sleep 0.1
      done
      cp /var/run/amavis/amavisd.pid /unrelated.pid
      kill -0 "$(cat /unrelated.pid)"`);
    const stale = await run("timeout 5 amavisd -c /amavis-test.conf foreground", true);
    expect(stale.code).not.toBe(0);
    expect(stale.code).not.toBe(124);
    expect(stale.stdout + stale.stderr).toMatch(/pid.file|valid PID|process/i);

    await run(`${PREPARE}
      test ! -e /var/run/amavis/amavisd.pid
      kill -0 "$(cat /unrelated.pid)"
      amavisd -c /amavis-test.conf foreground >/amavis.log 2>&1 &
      daemon_pid=$!
      trap 'kill "$daemon_pid" "$(cat /unrelated.pid)" 2>/dev/null || true; wait "$daemon_pid" 2>/dev/null || true' EXIT
      for attempt in $(seq 1 50); do
        if nc -z -w 1 127.0.0.1 10024 && nc -z -w 1 127.0.0.1 10026; then break; fi
        sleep 0.1
      done
      for port in 10024 10026; do
        printf 'EHLO example.test\r\nQUIT\r\n' | nc -w 3 127.0.0.1 "$port" > "/smtp-$port.log"
        grep -q '^220 ' "/smtp-$port.log"
        grep -q '^250' "/smtp-$port.log"
      done`);
  });

  it("repairs runtime ownership after restart, creates a missing directory and preserves mail data", async () => {
    await run(`printf keep > /var/lib/amavis/preserved-test-data
      printf stale > /var/run/amavis/amavisd.lock
      printf stale > /var/run/amavis/amavisd.socket
      chown root:root /var/run/amavis
      chmod 0777 /var/run/amavis`);
    // The writable layer survives a real restart. The runtime preparer is the
    // same script the production entrypoint runs before starting supervisord.
    await docker(["restart", RUNNER]);
    await run(`${PREPARE}
      test ! -e /var/run/amavis/amavisd.lock
      test ! -e /var/run/amavis/amavisd.socket
      test "$(stat -c '%U:%G:%a' /var/run/amavis)" = amavis:amavis:750
      test "$(cat /var/lib/amavis/preserved-test-data)" = keep
      rmdir /var/run/amavis
      ${PREPARE}
      ${PREPARE}
      test "$(stat -c '%U:%G:%a' /var/run/amavis)" = amavis:amavis:750
      test "$(cat /var/lib/amavis/preserved-test-data)" = keep`);
  });
});
