/** Real SMTP AUTH → Postfix sender map → pinned iRedAPD → PostgreSQL.
 * All traffic stays on the isolated Docker network, including the test relay. */
import { OBLIEN_RELAY } from "@repo/core";
import { ensureMailCustomerGroupSql, tenantDatabaseEnrollmentSql } from "@repo/platform/engine/modules/mail/admin/tenant-database";
import { sharedImapPolicy } from "@repo/platform/engine/modules/mail/admin/shared-imap";
import { applySharedSubmission, sharedRelayMap } from "@repo/platform/engine/modules/mail/admin/shared-relay";
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
const sink = `openship-alias-relay-${suffix}`;
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
    await docker(["rm", "-f", runner, db, sink], true);
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
  it("isolates two shared inboxes and attributes native submissions to their domain credentials", async () => {
    const first = "bob@example.test", second = "bob@other.test";
    await query(`INSERT INTO mailbox (username, domain) VALUES ('${second}', 'other.test')`);
    await run("sh", "-ec", `printf '%s\\n' '${second}:{PLAIN}isolated-second' >> /etc/dovecot/alias-users
      mkdir -p /etc/dovecot/iredmail
      install -d -o nobody -g nogroup /tmp/test-mail/example.test/bob /tmp/test-mail/other.test/bob
      sed -i 's/^protocols =$/protocols = imap/;s@home=/tmp$@home=/tmp/test-mail/%d/%n@' /etc/dovecot/dovecot.conf`);
    await run("sh", "-ec", `cat >> /etc/dovecot/dovecot.conf <<'CONFIG'
mail_location = maildir:~/Maildir
hostname = mail.example.test
postmaster_address = postmaster@example.test
service auth {
  unix_listener auth-userdb {
    mode = 0600
    user = nobody
  }
}
namespace inbox {
  inbox = yes
  separator = /
}
namespace shared {
  type = shared
  prefix = Shared/%%u/
  separator = /
  location = maildir:%%h/Maildir
  subscriptions = no
}
protocol imap {
  mail_plugins = acl imap_acl
}
plugin {
  acl = vfile
}
!include_try /etc/dovecot/iredmail/*.conf
CONFIG`);
    await run("sh", "-ec", sharedImapPolicy);
    await run("sh", "-ec", sharedImapPolicy);
    // Use the production Postfix → Dovecot delivery agent, with two fixture recipients.
    await run("postconf", "-M", 'dovecot/unix=dovecot unix - n n - - pipe flags=DRh user=nobody:nogroup argv=/usr/lib/dovecot/deliver -f ${sender} -d ${recipient}');
    await put("/etc/postfix/test-mailboxes", [first + " yes", second + " yes", ""].join("\n"));
    await run("chown", "root:root", "/etc/postfix/test-mailboxes");
    await run("postmap", "/etc/postfix/test-mailboxes");
    await run("postconf", "-e", "virtual_mailbox_domains=example.test,other.test",
      "virtual_mailbox_maps=hash:/etc/postfix/test-mailboxes", "virtual_transport=dovecot", "dovecot_destination_recipient_limit=1");
    await run("postconf", "-P", "smtp/inet/smtpd_recipient_restrictions=reject_unauth_destination");
    for (const name of ["submission", "465"])
      await run("postconf", "-M", name + "/inet=" + name + " inet n - n - - smtpd");
    const map = "/etc/postfix/shared-senders";
    const firstKey = sharedRelayMap("", { domain: "example.test", namespace: "tenant-one", key: "key-one" });
    await put(map, sharedRelayMap(firstKey, { domain: "other.test", namespace: "tenant-two", key: "key-two" }));
    await applySharedSubmission(command => run("sh", "-ec", command), map);
    await run("python3", "-c", `
import smtplib
with smtplib.SMTP('127.0.0.1', 25, timeout=10) as smtp:
    for address in ['${first}', '${second}']:
        smtp.sendmail('source@outside.test', address, 'Subject: '+address+'\\r\\n\\r\\nprivate')
`);
    await vi.waitFor(async () => {
      for (const domain of ["example.test", "other.test"]) {
        const delivered = await run("sh", "-c", "ls /tmp/test-mail/" + domain + "/bob/Maildir/new 2>/dev/null || true");
        expect(delivered.trim()).not.toBe("");
      }
    }, { timeout: 15_000, interval: 300 });
    await run("python3", "-c", `
import imaplib
for user, password in [('${first}', '${password}'), ('${second}', 'isolated-second')]:
    with imaplib.IMAP4('127.0.0.1') as client:
        client.login(user, password)
        assert b'ACL' not in client.capability()[1][0].split()
        assert client.select('INBOX')[1] == [b'1']
        assert ('Subject: '+user).encode() in client.fetch('1', '(BODY.PEEK[HEADER.FIELDS (SUBJECT)])')[1][0][1]
        assert all(b'Shared/' not in row for row in client.list()[1])
        other = '${second}' if user == '${first}' else '${first}'
        assert client.select('Shared/'+other+'/INBOX')[0] == 'NO'
`);
    await docker(["run", "-d", "--name", sink, "--network", network, "--network-alias", OBLIEN_RELAY.hostTemplate, image]);
    await docker(["exec", sink, "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-keyout", "/tmp/relay.key", "-out", "/tmp/relay.crt", "-subj", "/CN=" + OBLIEN_RELAY.hostTemplate,
      "-addext", "subjectAltName=DNS:" + OBLIEN_RELAY.hostTemplate]);
    await docker(["cp", join(root, "apps/api/test/e2e/fixtures/mail-alias/relay.py"), sink + ":/relay.py"]);
    await docker(["exec", "-d", sink, "python3", "/relay.py"]);
    await put("/etc/postfix/test-ca.pem", await docker(["exec", sink, "cat", "/tmp/relay.crt"]));
    await run("postconf", "-e", "smtp_tls_CAfile=/etc/postfix/test-ca.pem");
    await run("postfix", "reload");
    await run("python3", "-c", `
import smtplib
for user, password, other in [('${first}', '${password}', '${second}'), ('${second}', 'isolated-second', '${first}')]:
    with smtplib.SMTP('127.0.0.1', 587, timeout=10) as smtp:
        smtp.login(user, password)
        try:
            smtp.sendmail(other, 'sink@external.test', 'Subject: foreign\\r\\n\\r\\n')
            raise AssertionError('foreign sender accepted')
        except (smtplib.SMTPSenderRefused, smtplib.SMTPRecipientsRefused):
            pass
        recipients = ['sink@external.test'] if user == '${first}' else ['one@external.test', 'two@external.test']
        smtp.sendmail(user, recipients, 'Subject: private fixture\\r\\n\\r\\n')
`);
    await vi.waitFor(async () => {
      const receipts = await docker(["exec", sink, "cat", "/tmp/receipts"], true);
      expect(receipts.trim().split("\n").filter(Boolean).map(line => JSON.parse(line)).sort())
        .toEqual([["tenant-one", first, 1], ["tenant-two", second, 2]]);
    }, { timeout: 35_000, interval: 500 });

    // Migrate both domains to the API. The handler records recipients by the
    // credential it received, as the real Cloud endpoint does in its route tests.
    await applySharedSubmission(command => run("sh", "-ec", command), map, false);
    await put("/tmp/test-api.py", `
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
import json
class API(BaseHTTPRequestHandler):
    def do_POST(self):
        assert self.path == '/api/mail/send'
        tenant = {'Bearer opsh_send_first': 'first', 'Bearer opsh_send_second': 'second'}[self.headers['Authorization']]
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        if tenant == 'first':
            previous = Path('/tmp/api-retry')
            if not previous.exists():
                previous.write_text(body['idempotencyKey'])
                self.send_response(503)
                self.end_headers()
                return
            assert previous.read_text() == body['idempotencyKey']
        with open('/tmp/api-receipts', 'a') as out: print(json.dumps([tenant, body]), file=out)
        self.send_response(202)
        self.end_headers()
        self.wfile.write(b'{"id":"test","state":"queued"}')
HTTPServer(('127.0.0.1', 8765), API).serve_forever()
`);
    await docker(["exec", "-d", runner, "python3", "/tmp/test-api.py"]);
    for (const [i, domain] of ["example.test", "other.test"].entries()) {
      const nonce = randomUUID(), token = i ? "second" : "first";
      await put("/etc/postfix/sasl_passwd.api-" + nonce, JSON.stringify({
        domain, binding: (i ? "b" : "a").repeat(64), apiOrigin: "http://127.0.0.1:8765",
        keyId: token, key: "opsh_send_" + token,
      }));
      await run("python3", "-I", "/opt/openship-mail/api-relay-config.py", "install", domain, nonce);
      await run("rm", "/etc/postfix/sasl_passwd.api-" + nonce);
    }
    await run("python3", "-I", "/opt/openship-mail/api-relay-config.py", "restore");
    for (const [own, other, letter] of [["example.test", "other.test", "a"], ["other.test", "example.test", "b"]] as const) {
      await docker(["exec", "--user", "omr" + letter.repeat(28), runner, "sh", "-ec",
        'test -r "/etc/postfix/openship-api/$1.json" && ! test -r "/etc/postfix/openship-api/$2.json"',
        "check", own, other]);
    }
    await docker(["exec", "--user", "omr" + "a".repeat(28), runner, "python3", "-c", `
from email.message import EmailMessage
import os, subprocess
assert 50000 <= os.getuid() <= 59999 and 50000 <= os.getgid() <= 59999
sender = '${first}'
msg = EmailMessage()
msg['From'], msg['Subject'] = sender, 'Fixture'
msg.set_content('Hello')
def submit(binding, login):
    return subprocess.run(['python3', '-I', '/opt/openship-mail/api-relay.py', binding, 'Q', login, sender,
                           'sink@external.test'], input=msg.as_bytes(), capture_output=True).returncode
assert submit('b' * 64, sender) == 77
assert submit('a' * 64, '${second}') == 65
msg.replace_header('From', '${second}')
assert submit('a' * 64, sender) == 65
msg.replace_header('From', sender)
msg.add_attachment(b'fixture', maintype='application', subtype='octet-stream', filename='example.bin')
assert submit('a' * 64, sender) == 65
`]);
    await run("python3", "-c", `
from email.message import EmailMessage
import smtplib
for user, password in [('${first}', '${password}'), ('${second}', 'isolated-second')]:
    msg = EmailMessage()
    msg['From'], msg['To'], msg['Subject'] = user, 'visible@external.test', 'API relay'
    msg.set_content('Hello')
    with smtplib.SMTP('127.0.0.1', 587, timeout=10) as smtp:
        smtp.login(user, password)
        smtp.send_message(msg, user, ['visible@external.test', 'blind@external.test'])
`);
    await vi.waitFor(async () => {
      expect(await run("postqueue", "-p")).toContain("OpenShip API relay temporarily unavailable");
    }, { timeout: 15_000, interval: 300 });
    await run("postqueue", "-f");
    await vi.waitFor(async () => {
      const receipts = (await docker(["exec", runner, "cat", "/tmp/api-receipts"], true)).trim();
      expect(receipts && receipts.split("\n").map(row => JSON.parse(row)).sort()).toEqual(
        [["first", first], ["second", second]].map(([tenant, from]) => [tenant, expect.objectContaining({
          from, to: ["visible@external.test"], bcc: ["blind@external.test"], subject: "API relay",
          idempotencyKey: expect.stringMatching(/^[0-9a-f]{64}$/),
        })]),
      );
    }, { timeout: 30_000, interval: 300 });
  });

  it("isolates two worker database logins while Dovecot and Postfix retain their service access", async () => {
    const first = "openship-mail-" + "a".repeat(32);
    const second = "openship-mail-" + "b".repeat(32);
    const asLogin = async (role: string, sql: string) =>
      (await docker(["exec", db, "psql", "-X", "-w", "-h", "/var/run/postgresql", "-U", role,
        "-d", "vmail", "-v", "ON_ERROR_STOP=1", "-qtAc", sql])).trim();
    await query(`CREATE ROLE vmail LOGIN; CREATE ROLE vmailadmin LOGIN;
      GRANT SELECT ON public.domain, public.mailbox TO vmail;
      GRANT SELECT, UPDATE ON public.domain TO vmailadmin;
      CREATE TABLE openship_domain_owner (domain text PRIMARY KEY, namespace text NOT NULL);
      INSERT INTO openship_domain_owner VALUES ('example.test','${first}'),('other.test','${second}')`);
    await query(tenantDatabaseEnrollmentSql(first));
    await query(tenantDatabaseEnrollmentSql(second));
    await query(tenantDatabaseEnrollmentSql(first));
    for (const [login, own, other] of [[first, "example.test", "other.test"], [second, "other.test", "example.test"]] as const) {
      expect(await asLogin(login, "SELECT domain FROM domain")).toBe(own);
      expect(await asLogin(login, "SELECT domain FROM openship_domain_owner")).toBe(own);
      expect(await asLogin(login, `UPDATE domain SET description='My workspace' WHERE domain='${own}' RETURNING domain`)).toBe(own);
      expect(await asLogin(login, `UPDATE domain SET description='My workspace' WHERE domain='${other}' RETURNING domain`)).toBe("");
      expect(await asLogin(login, "SELECT has_column_privilege(current_user,'mailbox','password','SELECT'), has_table_privilege(current_user,'openship_domain_owner','INSERT'), has_table_privilege(current_user,'mailbox','TRUNCATE')")).toBe("f|f|f");
    }
    expect(await asLogin("vmail", "SELECT count(*) FROM domain")).toBe("2");
    expect(await asLogin("vmailadmin", "SELECT count(*) FROM domain")).toBe("2");

    // Database dumps carry policies and grants, while login roles are cluster-local.
    const restored = db + "-restore";
    try {
      await docker(["run", "-d", "--name", restored, "--network", network, "-e", `POSTGRES_PASSWORD=${password}`,
        "-e", "POSTGRES_DB=vmail", "postgres:16-alpine"]);
      const sql = (role: string, query: string) => docker(["exec", restored, "psql", "-X", "-U", role,
        "-d", "vmail", "-v", "ON_ERROR_STOP=1", "-qtAc", query]);
      await vi.waitFor(async () => expect((await sql("postgres", "SELECT 1")).trim()).toBe("1"),
        { timeout: 60_000, interval: 500 });
      await sql("postgres", "CREATE ROLE vmail LOGIN; CREATE ROLE vmailadmin LOGIN");
      const dump = await docker(["exec", db, "pg_dump", "-U", "postgres", "--clean", "--if-exists", "--no-owner", "vmail"]);
      const archive = join(directory, "vmail.sql");
      await writeFile(archive, ensureMailCustomerGroupSql + ";\n" + dump);
      await docker(["cp", archive, restored + ":/vmail.sql"]);
      await docker(["exec", restored, "psql", "-X", "-U", "postgres", "-d", "vmail",
        "--single-transaction", "-v", "ON_ERROR_STOP=1", "-f", "/vmail.sql"]);
      await sql("postgres", tenantDatabaseEnrollmentSql(first));
      expect((await sql(first, "SELECT domain FROM domain")).trim()).toBe("example.test");
    } finally {
      await docker(["rm", "-fv", restored], true);
    }
  });

});
