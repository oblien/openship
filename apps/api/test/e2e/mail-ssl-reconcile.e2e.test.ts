import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { shellQuote as sq } from "@repo/core";
import { describeDockerE2E, requireDocker } from "../helpers/docker-e2e";

const exec = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const RUNNER = `openship-e2e-mailtls-${process.pid.toString(36)}`;
const IMAGE = "alpine:3.23";
const HOST = "mail.example.test";
const MAIL = `/test/live/${HOST}`;
const APEX = "/test/live/example.test";
const CERT = "/test/ssl/cert.pem";
const KEY = "/test/ssl/key.pem";

async function docker(args: string[]) {
  const { stdout } = await exec("docker", args, { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
  return stdout.trim();
}
const run = (script: string) => docker(["exec", RUNNER, "bash", "-euo", "pipefail", "-c", script]);
const reconcile = () =>
  run(`bash /reconcile-ssl.sh example.test /test/live ${sq(CERT)} ${sq(KEY)}`);

async function certificate(directory: string, hosts = HOST, expired = false) {
  await run(`
    mkdir -p ${sq(directory)}
    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 2 \
      -subj '/CN=mail-test' -addext ${sq(
        `subjectAltName=${hosts
          .split(",")
          .map((h) => `DNS:${h}`)
          .join(",")}`,
      )} \
      -keyout ${sq(`${directory}/privkey.pem`)} -out ${sq(`${directory}/fullchain.pem`)} 2>/dev/null
    ${expired ? `openssl x509 -in ${sq(`${directory}/fullchain.pem`)} -signkey ${sq(`${directory}/privkey.pem`)} -days 0 -out ${sq(`${directory}/fullchain.pem`)} 2>/dev/null` : ""}
  `);
}

// The production helper runs in Linux with OpenSSL 3 (Debian 12 mail image).
// Use those real collaborators instead of the macOS system LibreSSL or source
// string assertions. All files and daemons are confined to this disposable runner.
describeDockerE2E("mail TLS reconciliation on every container boot (#837)", () => {
  beforeAll(async () => {
    await requireDocker();
    await docker(["pull", IMAGE]);
    await docker(["run", "-d", "--name", RUNNER, IMAGE, "sleep", "600"]);
    await docker(["exec", RUNNER, "apk", "add", "--no-cache", "bash", "openssl"]);
    await docker([
      "cp",
      join(ROOT, "apps/email/docker/reconcile-ssl.sh"),
      `${RUNNER}:/reconcile-ssl.sh`,
    ]);
  });

  afterAll(async () => {
    await docker(["rm", "-f", RUNNER]).catch(() => {});
  });

  beforeEach(async () => {
    await run(`rm -rf /test
      mkdir -p /test/ssl /test/live
      printf 'fallback certificate' > ${sq(CERT)}
      printf 'fallback key' > ${sq(KEY)}
      chmod 600 ${sq(KEY)}`);
  });

  it("links a usable mounted pair and serves its identity over TLS", async () => {
    await certificate(MAIL);
    await reconcile();
    expect(await run(`readlink ${sq(CERT)}`)).toBe(`${MAIL}/fullchain.pem`);
    expect(await run(`readlink ${sq(KEY)}`)).toBe(`${MAIL}/privkey.pem`);
    await run(`
      openssl s_server -accept 127.0.0.1:10465 -cert ${sq(CERT)} -key ${sq(KEY)} -www -quiet >/test/server.log 2>&1 &
      tls_pid=$!
      trap 'kill "$tls_pid" 2>/dev/null || true' EXIT
      for attempt in $(seq 1 30); do
        if openssl s_client -brief -verify_return_error -verify_hostname ${sq(HOST)} \
          -CAfile ${sq(`${MAIL}/fullchain.pem`)} -connect 127.0.0.1:10465 </dev/null >/test/client.log 2>&1; then
          exit 0
        fi
        sleep 0.1
      done
      cat /test/client.log
      exit 1
    `);
  });

  it("repairs a stale key link even when the certificate link is already correct", async () => {
    await certificate(MAIL);
    await run(`rm ${sq(CERT)}; ln -s ${sq(`${MAIL}/fullchain.pem`)} ${sq(CERT)}`);
    await reconcile();
    expect(await run(`readlink ${sq(KEY)}`)).toBe(`${MAIL}/privkey.pem`);
  });

  it("keeps stable live links across repeated boots and certificate renewals", async () => {
    await certificate("/test/archive/first");
    await run(`mkdir -p ${sq(MAIL)}
      ln -s /test/archive/first/fullchain.pem ${sq(`${MAIL}/fullchain.pem`)}
      ln -s /test/archive/first/privkey.pem ${sq(`${MAIL}/privkey.pem`)}`);
    await reconcile();
    const links = await run(`stat -c '%i' ${sq(CERT)} ${sq(KEY)}`);
    await certificate("/test/archive/renewed");
    await run(`ln -sfn /test/archive/renewed/fullchain.pem ${sq(`${MAIL}/fullchain.pem`)}
      ln -sfn /test/archive/renewed/privkey.pem ${sq(`${MAIL}/privkey.pem`)}`);
    await reconcile();
    expect(await run(`stat -c '%i' ${sq(CERT)} ${sq(KEY)}`)).toBe(links);
    await run(`cmp ${sq(CERT)} /test/archive/renewed/fullchain.pem
      cmp ${sq(KEY)} /test/archive/renewed/privkey.pem`);
    expect(await run(`cat ${sq(`${CERT}.bak`)}`)).toBe("fallback certificate");
    expect(await run(`stat -c '%a' ${sq(`${KEY}.bak`)}`)).toBe("600");
  });

  it("restores the mounted identity after the container's certificate files are recreated", async () => {
    await certificate(MAIL);
    await reconcile();
    await run(`rm ${sq(CERT)} ${sq(KEY)}
      printf 'recreated certificate' > ${sq(CERT)}
      printf 'recreated key' > ${sq(KEY)}`);
    await reconcile();
    expect(await run(`readlink ${sq(CERT)}`)).toBe(`${MAIL}/fullchain.pem`);
    expect(await run(`readlink ${sq(KEY)}`)).toBe(`${MAIL}/privkey.pem`);
  });

  it.each(["missing", "wrong hostname", "expired", "mismatched key", "malformed"])(
    "preserves the fallback for a %s mounted certificate pair",
    async (mode) => {
      if (mode !== "missing") {
        await certificate(
          MAIL,
          mode === "wrong hostname" ? "example.test" : HOST,
          mode === "expired",
        );
        if (mode === "mismatched key") {
          await certificate("/test/other");
          await run(`cp /test/other/privkey.pem ${sq(`${MAIL}/privkey.pem`)}`);
        }
        if (mode === "malformed")
          await run(`printf 'invalid PEM' > ${sq(`${MAIL}/fullchain.pem`)}`);
      }
      await reconcile();
      expect(await run(`cat ${sq(CERT)}`)).toBe("fallback certificate");
      expect(await run(`cat ${sq(KEY)}`)).toBe("fallback key");
    },
  );

  it("uses an apex certificate only when it covers the mail hostname", async () => {
    await certificate(APEX, "example.test");
    await reconcile();
    expect(await run(`cat ${sq(CERT)}`)).toBe("fallback certificate");
    await certificate(APEX, "example.test,*.example.test");
    await reconcile();
    expect(await run(`readlink ${sq(CERT)}`)).toBe(`${APEX}/fullchain.pem`);
    await certificate(MAIL);
    await reconcile();
    expect(await run(`readlink ${sq(CERT)}`)).toBe(`${MAIL}/fullchain.pem`);
  });
});
