/** Real SMTP AUTH → Postfix sender map → pinned iRedAPD → PostgreSQL.
 * No published ports and no DATA command: this fixture cannot deliver mail. */
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { describeDockerE2E, requireDocker } from "../helpers/docker-e2e";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "../../../..");
const suffix = randomUUID().slice(0, 10);
const network = `openship-alias-net-${suffix}`;
const db = `openship-alias-db-${suffix}`;
const runner = `openship-alias-smtp-${suffix}`;
const image = "openship-mail-alias-fixture:review";
const password = "isolated-alias-test";
let directory: string;
async function docker(args: string[], allowFail = false) {
  try {
    return (await exec("docker", args, { timeout: 300_000, maxBuffer: 8 * 1024 * 1024 })).stdout;
  } catch (error) {
    if (!allowFail) throw error;
    return "";
  }
}
async function put(path: string, contents: string) {
  const local = join(directory, randomUUID());
  await writeFile(local, contents);
  await docker(["cp", local, `${runner}:${path}`]);
}
const query = (sql: string) =>
  docker([
    "exec",
    db,
    "psql",
    "-X",
    "-U",
    "postgres",
    "-d",
    "vmail",
    "-v",
    "ON_ERROR_STOP=1",
    "-tAc",
    sql,
  ]);
const run = (...args: string[]) => docker(["exec", runner, ...args]);
async function smtp(sender: string, user = "bob@example.test", authenticate = true) {
  return JSON.parse(
    await run(
      "python3",
      "-c",
      `
import json, smtplib, sys
with smtplib.SMTP('127.0.0.1', 25, timeout=10) as smtp:
    smtp.ehlo('client.example.test')
    if sys.argv[3] == 'yes': smtp.login(sys.argv[2], '${password}')
    code, message = smtp.mail(sys.argv[1])
    if code == 250: code, message = smtp.rcpt('sink@external.test')
    smtp.rset()
    print(json.dumps({'code': code, 'message': message.decode()}))
`,
      sender,
      user,
      authenticate ? "yes" : "no",
    ),
  ) as { code: number; message: string };
}
const owners = async (sender: string) => {
  let result: string;
  try {
    result = await run("postmap", "-q", sender, "pgsql:/etc/postfix/pgsql/sender_login_maps.cf");
  } catch (error) {
    // postmap uses 1 without a diagnostic for a successful lookup miss.
    const failure = error as { code?: number; stderr?: string };
    if (failure.code === 1 && !failure.stderr?.trim()) return [];
    throw error;
  }
  return result.trim().split(",").filter(Boolean).sort();
};

describeDockerE2E("direct sender aliases through real mail authentication and policy", () => {
  beforeAll(async () => {
    await requireDocker();
    directory = await mkdtemp(join(tmpdir(), "openship-mail-alias-"));
    const conf = await readFile(join(root, "apps/email/engine/conf/iredapd"), "utf8");
    const version = conf.match(/IREDAPD_VERSION='([^']+)'/)![1]!;
    await docker([
      "build",
      "--build-arg",
      `IREDAPD_VERSION=${version}`,
      "-f",
      join(root, "apps/api/test/e2e/fixtures/mail-alias/Dockerfile"),
      "-t",
      image,
      root,
    ]);
    await docker(["network", "create", "--internal", network]);
    await docker([
      "run",
      "-d",
      "--name",
      db,
      "--network",
      network,
      "--network-alias",
      "db",
      "-e",
      `POSTGRES_PASSWORD=${password}`,
      "-e",
      "POSTGRES_DB=vmail",
      "postgres:16-alpine",
    ]);
    await vi.waitFor(async () => expect((await query("SELECT 1")).trim()).toBe("1"), {
      timeout: 60_000,
      interval: 500,
    });
    await docker(["run", "-d", "--name", runner, "--network", network, image]);
    await docker([
      "cp",
      join(root, "apps/email/engine/samples/iredmail/iredmail.pgsql"),
      `${db}:/schema.sql`,
    ]);
    await docker([
      "exec",
      db,
      "psql",
      "-X",
      "-U",
      "postgres",
      "-d",
      "vmail",
      "-v",
      "ON_ERROR_STOP=1",
      "-f",
      "/schema.sql",
    ]);
    await query(`INSERT INTO domain (domain) VALUES ('example.test'), ('other.test');
      INSERT INTO mailbox (username, domain) VALUES ('bob@example.test', 'example.test'), ('alice@example.test', 'example.test'), ('mallory@example.test', 'example.test');
      INSERT INTO forwardings (address, forwarding, domain, dest_domain, is_alias) VALUES
      ('support@example.test', 'bob@example.test', 'example.test', 'example.test', 1),
      ('support@example.test', 'alice@example.test', 'example.test', 'example.test', 1),
      ('external@example.test', 'outside@external.test', 'example.test', 'external.test', 1),
      ('chain@example.test', 'support@example.test', 'example.test', 'example.test', 1),
      ('example.test', 'bob@example.test', 'example.test', 'example.test', 1),
      ('team@other.test', 'bob@example.test', 'other.test', 'example.test', 1);`);
    const sample = await readFile(
      join(root, "apps/email/engine/samples/postfix/pgsql/sender_login_maps.cf"),
      "utf8",
    );
    await run("mkdir", "-p", "/etc/postfix/pgsql", "/run/dovecot");
    await put(
      "/etc/postfix/pgsql/sender_login_maps.cf",
      sample
        .replaceAll("PH_SQL_SERVER_ADDRESS", "db")
        .replaceAll("PH_SQL_SERVER_PORT", "5432")
        .replaceAll("PH_VMAIL_DB_BIND_USER", "postgres")
        .replaceAll("PH_VMAIL_DB_BIND_PASSWD", password)
        .replaceAll("PH_VMAIL_DB_NAME", "vmail"),
    );
    await put(
      "/etc/dovecot/alias-users",
      ["bob", "alice", "mallory"]
        .map((name) => `${name}@example.test:{PLAIN}${password}`)
        .join("\n") + "\n",
    );
    await put(
      "/etc/dovecot/dovecot.conf",
      `protocols =
listen = 127.0.0.1
ssl = no
auth_mechanisms = plain login
disable_plaintext_auth = no
passdb {\n driver = passwd-file\n args = /etc/dovecot/alias-users\n}
userdb {\n driver = static\n args = uid=nobody gid=nogroup home=/tmp\n}
service auth {\n inet_listener {\n address = 127.0.0.1\n port = 12345\n }\n}
`,
    );
    await put(
      "/opt/iredapd/settings.py",
      `from libs.default_settings import *
listen_address = '127.0.0.1'
listen_port = 7777
pid_file = '/tmp/iredapd.pid'
run_as_user = 'nobody'
log_level = 'debug'
backend = 'pgsql'
plugins = ['reject_sender_login_mismatch']
srs_secrets = []
srs_domain = ''
MYNETWORKS = []
CHECK_SPF_IF_LOGIN_MISMATCH = False
ALLOWED_LOGIN_MISMATCH_SENDERS = []
ALLOWED_LOGIN_MISMATCH_STRICTLY = True
ALLOWED_LOGIN_MISMATCH_LIST_MEMBER = False
LOG_SMTP_SESSIONS = False
` +
        ["vmail", "amavisd", "iredapd"]
          .map(
            (key) =>
              `${key}_db_server = 'db'\n${key}_db_port = 5432\n${key}_db_name = 'vmail'\n${key}_db_user = 'postgres'\n${key}_db_password = '${password}'\n`,
          )
          .join(""),
    );
    await put(
      "/etc/postfix/main.cf",
      `myhostname = mail.example.test
mydestination =
inet_interfaces = loopback-only
inet_protocols = ipv4
mynetworks = 127.0.0.0/8
maillog_file = /var/log/postfix.log
smtpd_sasl_type = dovecot
smtpd_sasl_path = inet:127.0.0.1:12345
smtpd_sasl_auth_enable = yes
smtpd_tls_security_level = none
smtpd_sender_login_maps = pgsql:/etc/postfix/pgsql/sender_login_maps.cf
smtpd_sender_restrictions = reject_authenticated_sender_login_mismatch
smtpd_recipient_restrictions = check_policy_service inet:127.0.0.1:7777, permit_sasl_authenticated, reject
smtpd_relay_restrictions = permit_sasl_authenticated, reject_unauth_destination
`,
    );
    await run("postconf", "-M", "smtp/inet=smtp inet n - n - - smtpd");
    await run("dovecot");
    await docker([
      "exec",
      "-d",
      runner,
      "sh",
      "-c",
      "python3 /opt/iredapd/iredapd.py --foreground > /tmp/iredapd.log 2>&1",
    ]);
    await run("postfix", "start");
    await vi.waitFor(async () => expect((await smtp("bob@example.test")).code).toBe(250), {
      timeout: 30_000,
      interval: 500,
    });
  }, 300_000);
  afterAll(async () => {
    await writeFile(
      join(tmpdir(), "openship-alias-daemons.log"),
      await docker(
        ["exec", runner, "sh", "-c", "tail -n 100 /var/log/postfix.log /tmp/iredapd.log 2>&1 || true"],
        true,
      ),
    );
    await docker(["rm", "-f", runner, db], true);
    await docker(["network", "rm", network], true);
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("authorizes only the active direct recipients, including fan-out and explicit cross-domain aliases", async () => {
    expect(await owners("support@example.test")).toEqual([
      "alice@example.test",
      "bob@example.test",
    ]);
    expect((await smtp("support@example.test")).code).toBe(250);
    expect((await smtp("support@example.test", "alice@example.test")).code).toBe(250);
    expect((await smtp("team@other.test")).code).toBe(250);
    expect(
      (await smtp("support@example.test", "mallory@example.test")).code,
    ).toBeGreaterThanOrEqual(500);
    expect((await smtp("alice@example.test")).code).toBeGreaterThanOrEqual(500);
    expect(
      (await smtp("support@example.test", "bob@example.test", false)).code,
    ).toBeGreaterThanOrEqual(500);
  });

  it("does not turn external forwards, catch-alls or chains into sender permissions", async () => {
    for (const sender of [
      "external@example.test",
      "unknown@example.test",
      "example.test",
      "chain@example.test",
    ]) {
      expect(await owners(sender)).toEqual([]);
      expect((await smtp(sender)).code).toBeGreaterThanOrEqual(500);
    }
  });

  it("revokes disabled aliases, SMTP accounts and domains in each guard without a daemon restart", async () => {
    for (const usePostfixGuard of [true, false]) {
      await run(
        "postconf",
        "-e",
        `smtpd_sender_restrictions=${usePostfixGuard ? "reject_authenticated_sender_login_mismatch" : ""}`,
      );
      await run("postfix", "reload");
      for (const [disable, restore, sender] of [
        [
          "UPDATE forwardings SET active=0 WHERE address='support@example.test'",
          "UPDATE forwardings SET active=1",
          "support@example.test",
        ],
        [
          "UPDATE mailbox SET enablesmtp=0 WHERE username='bob@example.test'",
          "UPDATE mailbox SET enablesmtp=1",
          "team@other.test",
        ],
        [
          "UPDATE mailbox SET active=0 WHERE username='bob@example.test'",
          "UPDATE mailbox SET active=1",
          "team@other.test",
        ],
        [
          "UPDATE domain SET active=0 WHERE domain='other.test'",
          "UPDATE domain SET active=1",
          "team@other.test",
        ],
        [
          "UPDATE domain SET active=0 WHERE domain='example.test'",
          "UPDATE domain SET active=1",
          "team@other.test",
        ],
        [
          "UPDATE domain SET backupmx=1 WHERE domain='other.test'",
          "UPDATE domain SET backupmx=0",
          "team@other.test",
        ],
      ]) {
        await query(disable!);
        try {
          expect((await smtp(sender!)).code).toBeGreaterThanOrEqual(500);
        } finally {
          await query(restore!);
        }
        expect((await smtp(sender!)).code).toBe(250);
      }
    }
    await query("DELETE FROM forwardings WHERE address='team@other.test'");
    expect((await smtp("team@other.test")).code).toBeGreaterThanOrEqual(500);
  });

  it("keeps the build-time policy patch idempotent", async () => {
    await run(
      "python3",
      "/opt/openship-mail/sender_aliases.py",
      "/opt/iredapd/plugins/reject_sender_login_mismatch.py",
      "/opt/iRedMail-engine/samples/postfix/pgsql/sender_login_maps.cf",
    );
    expect((await smtp("support@example.test")).code).toBe(250);
  });

  it("upgrades the persisted legacy sender map without changing its database credentials", async () => {
    const path = "/etc/postfix/pgsql/sender_login_maps.cf";
    const previous = await run("cat", path);
    await run("python3", "-c", `
import sys, re
from pathlib import Path
sys.path.insert(0, '/opt/openship-mail')
from sender_aliases import LEGACY_QUERY
p = Path('${path}')
p.write_text(re.sub(r'^query\\s*=.*$', 'query = ' + LEGACY_QUERY, p.read_text(), flags=re.MULTILINE))
`);
    expect(await owners("support@example.test")).toEqual([]);
    await run("python3", "/opt/openship-mail/reconcile-db-port.py", "5432");
    expect(await owners("support@example.test")).toEqual(["alice@example.test", "bob@example.test"]);
    const updated = await run("cat", path);
    expect(updated.replace(/^query\s*=.*$/m, "")).toBe(previous.replace(/^query\s*=.*$/m, ""));
  });
});
