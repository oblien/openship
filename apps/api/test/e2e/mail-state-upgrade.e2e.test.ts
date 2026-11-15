import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, beforeEach, afterEach, expect, it } from "vitest";
import { shellQuote as sq } from "@repo/core";
import type { CommandExecutor } from "@repo/adapters";
import { preserveMailState } from "../../../../packages/adapters/src/system/mail/preserve-mail-state";
import { describeDockerE2E, requireDocker } from "../helpers/docker-e2e";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "../../../..");
const suffix = randomUUID().slice(0, 8);
const host = `mail-state-host-${suffix}`;
const image = `openship-mail-state:${suffix}`;
const legacy = "openship-mail";
const state = "/var/lib/openship/mail";

async function docker(args: string[], allowFail = false) {
  try {
    const { stdout } = await exec("docker", args, { timeout: 600_000, maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    if (!allowFail) throw error;
    return "";
  }
}
const run = (command: string, allowFail = false) =>
  docker(["exec", host, "sh", "-ec", command], allowFail);
const inMail = (command: string) => run(`docker exec ${legacy} sh -ec ${sq(command)}`);
function executor(injectFailure = false): CommandExecutor {
  return {
    exec: async (command: string) =>
      run(`${injectFailure ? "PATH=/review-bin:$PATH " : ""}sh -c ${sq(command)}`),
  } as CommandExecutor;
}
async function ready() {
  await run(`for attempt in $(seq 1 80); do
    if docker exec ${legacy} fail2ban-client ping >/dev/null 2>&1 && docker exec ${legacy} test -S /dev/log; then exit 0; fi
    sleep 0.1
  done
  docker logs ${legacy}
  exit 1`);
}
async function start(mounts = "") {
  await run(`docker run -d --network none --name ${legacy} ${mounts} ${image}`);
  await ready();
}
async function identity() {
  return (await run(`docker inspect -f '{{.Id}} {{.State.Running}}' ${legacy}`)).trim();
}
async function restoredBan() {
  await inMail(`for attempt in $(seq 1 50); do
    fail2ban-client get review banip | grep -q 203.0.113.9 && exit 0
    sleep 0.1
  done
  tail -80 /var/log/supervisor/fail2ban.log
  sqlite3 /var/lib/fail2ban/fail2ban.sqlite3 'select * from bans;'
  exit 1`);
}

describeDockerE2E("mail logs and fail2ban across the first persistent-state upgrade", () => {
  beforeAll(async () => {
    await requireDocker();
    await docker([
      "build",
      "-q",
      "-t",
      image,
      "-f",
      resolve(root, "apps/api/test/e2e/fixtures/mail-state/Dockerfile"),
      root,
    ]);
    // A dedicated nested daemon keeps the production host paths and every
    // destructive test command inside this fixture, away from the user's host.
    await docker([
      "run",
      "-d",
      "--privileged",
      "--name",
      host,
      "-e",
      "DOCKER_TLS_CERTDIR=",
      "docker:28-dind",
      "--host=unix:///var/run/docker.sock",
    ]);
    await run(
      "for attempt in $(seq 1 80); do docker info >/dev/null 2>&1 && exit 0; sleep 0.25; done; exit 1",
    );
    await new Promise<void>((resolvePromise, reject) => {
      const save = spawn("docker", ["save", image], { stdio: ["ignore", "pipe", "pipe"] });
      const load = spawn("docker", ["exec", "-i", host, "docker", "load"], {
        stdio: ["pipe", "ignore", "pipe"],
      });
      save.stdout.pipe(load.stdin);
      const errors: string[] = [];
      for (const stream of [save.stderr, load.stderr])
        stream.on("data", (data) => errors.push(data.toString()));
      Promise.all(
        [save, load].map(
          (child) =>
            new Promise<void>((ok, fail) => {
              child.once("error", fail);
              child.once("exit", (code) => (code === 0 ? ok() : fail(new Error(errors.join("")))));
            }),
        ),
      ).then(() => resolvePromise(), reject);
    });
  }, 600_000);
  beforeEach(async () => {
    await run(`docker rm -f ${legacy} >/dev/null 2>&1 || true
      rm -rf ${state} /review-bin
      mkdir -p ${state}`);
  });
  afterAll(async () => {
    await docker(["rm", "-f", host], true);
    await docker(["image", "rm", image], true);
  });
  afterEach(async (context) => {
    if (context.task.result?.state === "fail")
      console.error(
        await run(
          `docker logs --tail 60 ${legacy}; docker exec ${legacy} tail -80 /var/log/supervisor/fail2ban.log`,
          true,
        ),
      );
  });

  it("restores an empty log mount, rotates active logs, and retains logs and real bans after recreation", async () => {
    await start();
    await inMail(
      "logger -p local5.info preserved-before-upgrade; fail2ban-client set review banip 203.0.113.9",
    );
    await preserveMailState(executor(), legacy);
    expect(await identity()).toMatch(/ false$/);
    await run(`docker rm ${legacy} >/dev/null`);
    await start(`-v ${state}/logs:/var/log -v ${state}/fail2ban:/var/lib/fail2ban`);
    expect(await inMail("cat /var/log/dovecot/dovecot.log")).toContain("preserved-before-upgrade");
    await restoredBan();
    // Empty persisted logs and changed image UIDs must also be repaired.
    await inMail(
      "chown root:root /var/log/clamav; bash /opt/openship-mail/prepare-mail-logs.sh; runuser -u clamav -- sh -c 'echo writable >> /var/log/clamav/freshclam.log'",
    );
    expect((await inMail("stat -c '%U:%G' /var/log/clamav")).trim()).toBe("clamav:clamav");
    await inMail(
      "logrotate -f /etc/logrotate.conf; logger -p local5.info written-after-rotation; sleep 0.2",
    );
    expect(await inMail("cat /var/log/dovecot/dovecot.log")).toContain("written-after-rotation");
    const before = await identity();
    await preserveMailState(executor(), legacy);
    expect(await identity()).toBe(before);
    // A second real recreate reuses the retained directories without migrating.
    await run(`docker rm -f ${legacy} >/dev/null`);
    await start(`-v ${state}/logs:/var/log -v ${state}/fail2ban:/var/lib/fail2ban`);
    await restoredBan();
    expect(await inMail("cat /var/log/dovecot/dovecot.log")).toContain("written-after-rotation");
  });

  it("creates ClamAV's writable log directory on an actually empty bind mount", async () => {
    await run(`mkdir ${state}/logs ${state}/fail2ban`);
    await start(`-v ${state}/logs:/var/log -v ${state}/fail2ban:/var/lib/fail2ban`);
    await inMail("runuser -u clamav -- sh -c 'echo ready >> /var/log/clamav/freshclam.log'");
    const output = await inMail("timeout 2 freshclam --daemon --foreground=true 2>&1 || true");
    expect(output).not.toMatch(/Problem with internal logger|Failed to open log file/);
    expect(await inMail("cat /var/log/clamav/freshclam.log")).toContain("ready");
  });

  it("reopens Freshclam's log through Supervisor after native rotation", async () => {
    await start();
    await inMail("supervisorctl -c /opt/openship-mail/supervisord.conf start clamav-freshclam");
    await inMail(`logrotate -f /etc/logrotate.d/clamav-freshclam
      for attempt in $(seq 1 100); do
        if [ -s /var/log/clamav/freshclam.log ]; then exit 0; fi
        sleep 0.1
      done
      cat /var/log/supervisor/freshclam.log
      exit 1`);
    expect(await inMail("cat /var/log/clamav/freshclam.log.1")).toContain(
      "ClamAV update process started",
    );
    expect(await inMail("cat /var/log/clamav/freshclam.log")).toMatch(
      /re-opening log|ClamAV update process started/,
    );
  });

  it.each([false, true])(
    "restores the original run state after a failed second copy (stopped=%s)",
    async (stopped) => {
      await start();
      await inMail("echo retained > /var/log/mail.log");
      if (stopped) await run(`docker stop ${legacy}`);
      const before = await identity();
      await run(`mkdir /review-bin
      printf '%s\n' '#!/bin/sh' 'if [ "$1" = cp ] && echo "$3" | grep -q /var/lib/fail2ban; then echo injected-copy-failure >&2; exit 70; fi' 'exec /usr/local/bin/docker "$@"' > /review-bin/docker
      chmod +x /review-bin/docker`);
      await expect(preserveMailState(executor(true), legacy)).rejects.toThrow(
        "injected-copy-failure",
      );
      expect(await identity()).toBe(before);
      expect(await run(`docker cp ${legacy}:/var/log/mail.log - | tar -xOf -`)).toContain(
        "retained",
      );
      expect((await run(`find ${state} -mindepth 1 -maxdepth 1`)).trim()).toBe("");
    },
  );

  it("does not overwrite retained host data or stop the original container on conflict", async () => {
    await start();
    const before = await identity();
    await run(`mkdir ${state}/logs; echo keep > ${state}/logs/customer-data`);
    await expect(preserveMailState(executor(), legacy)).rejects.toThrow("would be overwritten");
    expect(await identity()).toBe(before);
    expect((await run(`cat ${state}/logs/customer-data`)).trim()).toBe("keep");
  });

  it("rolls back the first publish when the second rename fails", async () => {
    await start();
    const before = await identity();
    await run(`mkdir /review-bin
      printf '%s\n' '#!/bin/sh' 'if [ "$1" = -T ] && [ "$3" = ${state}/fail2ban ]; then echo injected-publish-failure >&2; exit 71; fi' 'exec /bin/mv "$@"' > /review-bin/mv
      chmod +x /review-bin/mv`);
    await expect(preserveMailState(executor(true), legacy)).rejects.toThrow(
      "injected-publish-failure",
    );
    expect(await identity()).toBe(before);
    expect((await run(`find ${state} -mindepth 1 -maxdepth 1`)).trim()).toBe("");
  });
});
