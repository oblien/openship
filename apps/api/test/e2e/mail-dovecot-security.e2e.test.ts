import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeDockerE2E, requireDocker } from "../helpers/docker-e2e";

const exec = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const runner = `openship-e2e-dovecot-security-${process.pid.toString(36)}`;
const verify = "sh /verify-dovecot-security.sh";

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
  docker(["exec", runner, "sh", "-ec", script], allowFail);

describeDockerE2E("mail image Dovecot security floor", () => {
  beforeAll(async () => {
    await requireDocker();
    await docker(["run", "-d", "--name", runner, "debian:12-slim", "sleep", "1800"]);
    // No ports are published, and package installation may not start daemons.
    await run("printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d; chmod +x /usr/sbin/policy-rc.d");
    await docker(["exec", runner, "apt-get", "update"]);
    await docker([
      "exec", "--env", "DEBIAN_FRONTEND=noninteractive", runner,
      "apt-get", "install", "-y", "--no-install-recommends",
      "dovecot-core", "dovecot-sieve", "dovecot-managesieved",
    ]);
    await docker(["network", "disconnect", "bridge", runner]);
    await docker([
      "cp", join(root, "apps/email/docker/verify-dovecot-security.sh"),
      `${runner}:/verify-dovecot-security.sh`,
    ]);
  });

  afterAll(async () => {
    await docker(["rm", "-f", runner], true);
  });

  it("accepts the real Debian security packages and compiles a mailbox sender filter", async () => {
    expect((await run(verify)).stdout).toContain("verified security updates for dovecot-managesieved");
    await run(`mkdir -p /filters
printf 'keep;\n' > /filters/previous-filter.sieve
cat > /blocked-senders.sieve <<'SIEVE'
require ["fileinto", "include"];
if address :is "from" "blocked@example.test" {
  fileinto "Junk";
  stop;
}
include :personal "previous-filter";
SIEVE
sievec -c /etc/dovecot/dovecot.conf -o plugin/sieve=file:/filters /blocked-senders.sieve
test -s /blocked-senders.svbin`);
  });

  it.each([
    ["dovecot-core", "install ok installed", "1:2.3.19.1+dfsg1-2.1+deb12u6"],
    ["dovecot-sieve", "install ok installed", "1:2.3.19.1+dfsg1-2.1+deb12u6"],
    ["dovecot-managesieved", "install ok installed", "1:2.3.19.1+dfsg1-2.1+deb12u6"],
    ["dovecot-sieve", "deinstall ok config-files", "1:2.3.19.1+dfsg1-2.1+deb12u7"],
    ["dovecot-managesieved", "missing", ""],
  ])("rejects unsafe package metadata: %s (%s, %s)", async (target, status, version) => {
    // Exercise the production check against a separate dpkg database. The real
    // packages stay intact, and no vulnerable binary is downloaded or executed.
    await run(`mkdir -p /fixture-dpkg
: > /fixture-dpkg/status
for package in dovecot-core dovecot-sieve dovecot-managesieved; do
  if [ "$package" = "${target}" ]; then
    [ "${status}" != missing ] || continue
    printf 'Package: %s\nStatus: %s\nVersion: %s\nArchitecture: all\nMaintainer: Test <test@example.test>\nDescription: security fixture\n\n' \
      "$package" "${status}" "${version}" >> /fixture-dpkg/status
  else
    dpkg-query -s "$package" >> /fixture-dpkg/status
    printf '\n' >> /fixture-dpkg/status
  fi
done`);
    const result = await run(`DPKG_ADMINDIR=/fixture-dpkg ${verify}`, true);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(`FATAL: ${target} must be installed`);
  });
});
