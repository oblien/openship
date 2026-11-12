/** Runs inside a disposable Linux host, so the local transport is exercised on
 * the real PostgreSQL/Postfix/Dovecot filesystem, never the developer's host. */
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { LocalExecutor, initPlatform, resetPlatform, type CommandExecutor } from "@repo/adapters";
import { shellQuote as sq } from "@repo/core";
import { repos, closeDb } from "@repo/db";
import { encrypt, decrypt } from "@repo/platform/engine/lib/encryption";
import { encryptSecretField } from "@repo/platform/engine/lib/credential-encryption";
import { resolvePlatformConfig } from "@repo/platform/engine/lib/platform-config";
import { buildBackgroundContext } from "@repo/platform/engine/lib/background-context";
import { sshManager } from "@repo/platform/engine/lib/ssh-manager";
import {
  makeFreshState,
  readState,
  writeState,
} from "@repo/platform/engine/modules/mail/mail-state";
import { backupOrchestrator } from "@repo/platform/engine/modules/backups/backup.orchestrator";
import { restoreOrchestrator } from "@repo/platform/engine/modules/backups/restore.orchestrator";
import {
  mailEngineCommand,
  mailHostPath,
  mailPsqlFromStdin,
  pauseMailDaemons,
  type MailEngineFlavor,
} from "@repo/platform/engine/modules/mail/mail-engine";
import {
  seedOrg,
  seedBackupDestination,
  seedBackupPolicy,
  seedBackupRun,
} from "../../../helpers/seed";

const local = new LocalExecutor();
const domain = "example.test";
const user = `alice@${domain}`;
const password = "mail-restore-fixture-password";
const flavors = new WeakMap<CommandExecutor, MailEngineFlavor>();
const flavorFor = (exec: CommandExecutor) => flavors.get(exec) ?? "host";
const mail = (exec: CommandExecutor, command: string) =>
  exec.exec(mailEngineCommand(flavorFor(exec), `sh -ec ${sq(command)}`));
const mailFile = (exec: CommandExecutor, path: string) =>
  exec.readFile(mailHostPath(flavorFor(exec), path));
const sql = (exec: CommandExecutor, statement: string, db = "vmail") =>
  exec.exec(
    `${flavorFor(exec) === "container" ? "docker exec openship-mail-db psql -U postgres" : "sudo -u postgres psql"} -v ON_ERROR_STOP=1 -d ${sq(db)} -Atc ${sq(statement)}`,
  );
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

async function setup(
  exec: CommandExecutor,
  serverId: string,
  dbPassword: string,
  source: boolean,
  flavor: MailEngineFlavor = "host",
) {
  flavors.set(exec, flavor);
  if (flavor === "host") await exec.exec("systemctl start postgresql");
  await sql(
    exec,
    `CREATE ROLE vmail LOGIN PASSWORD '${dbPassword}'; CREATE ROLE vmailadmin LOGIN; CREATE ROLE amavisd LOGIN; CREATE ROLE iredapd LOGIN; CREATE ROLE fail2ban LOGIN`,
    "postgres",
  );
  for (const name of ["vmail", "amavisd", "iredapd", "fail2ban"]) {
    if (flavor === "container" && name === "vmail") continue;
    await exec.exec(
      `${flavor === "container" ? "docker exec openship-mail-db createdb -U postgres" : "sudo -u postgres createdb"} ${name}`,
    );
  }
  const schema = await readFile("apps/email/engine/samples/iredmail/iredmail.pgsql", "utf8");
  assert.equal(
    (await exec.execWithInput!(mailPsqlFromStdin(flavor), Readable.from([schema]))).code,
    0,
  );
  await sql(
    exec,
    `GRANT SELECT ON ALL TABLES IN SCHEMA public TO vmail;
    CREATE SCHEMA mail_app;
    CREATE TABLE mail_app.notes(id serial PRIMARY KEY, body text NOT NULL);
    INSERT INTO mail_app.notes(body) VALUES ('${source ? "source-note" : "target-note"}');
    INSERT INTO domain(domain) VALUES ('example.test'),('second.test');
    INSERT INTO mailbox(username,password,domain,maildir,storagebasedirectory,storagenode) VALUES ('${user}','{PLAIN}${password}','example.test','example.test/alice/','/var/vmail','vmail1');
    INSERT INTO alias(address,domain) VALUES ('team@example.test','example.test');
    INSERT INTO forwardings(address,forwarding,domain) VALUES ('team@example.test','${user}','example.test');
    INSERT INTO alias_domain(alias_domain,target_domain) VALUES ('alias.test','example.test');
    INSERT INTO sender_bcc_user(username,bcc_address,domain) VALUES ('${user}','audit@example.test','example.test');`,
  );
  for (const name of ["amavisd", "iredapd", "fail2ban"]) {
    await sql(
      exec,
      `CREATE TABLE restored_rows(id serial PRIMARY KEY, body text); INSERT INTO restored_rows(body) VALUES ('${source ? "source" : "target"}-${name}');`,
      name,
    );
  }
  await mail(
    exec,
    `sh -ec ${sq(`install -d -o vmail -g vmail /var/vmail/vmail1/example.test/alice/Maildir/{cur,new,tmp}
    chown -R vmail:vmail /var/vmail
    install -d -m 0700 /var/lib/dkim
    openssl genrsa -out /var/lib/dkim/example.test.pem 2048 2>/dev/null
    openssl genrsa -out /var/lib/dkim/second.test.pem 2048 2>/dev/null
    chown -R amavis:amavis /var/lib/dkim
    chmod 0700 /var/lib/dkim
    chmod 0600 /var/lib/dkim/*.pem`)}`,
  );
  const config = `protocols = imap
listen = 127.0.0.1
ssl = no
disable_plaintext_auth = no
mail_location = maildir:/var/vmail/vmail1/%d/%n/Maildir
auth_mechanisms = plain login
passdb {
  driver = sql
  args = /etc/dovecot/backup-test-sql.conf
}
userdb {
  driver = static
  args = uid=vmail gid=vmail home=/var/vmail/vmail1/%d/%n
}
service auth-worker {
  user = root
}
`;
  await exec.writeFile(mailHostPath(flavor, "/etc/dovecot/dovecot.conf"), config);
  await exec.writeFile(
    mailHostPath(flavor, "/etc/dovecot/backup-test-sql.conf"),
    `driver = pgsql\nconnect = host=127.0.0.1 dbname=vmail user=vmail password=${dbPassword}\npassword_query = SELECT password FROM mailbox WHERE username = '%u' AND active = 1\n`,
  );
  await mail(exec, "chmod 0600 /etc/dovecot/backup-test-sql.conf");
  const amavis = `use strict;
$mydomain = 'example.test';
$myhostname = 'mail.example.test';
$daemon_user = 'amavis'; $daemon_group = 'amavis';
$MYHOME = '/var/lib/amavis';
$TEMPBASE = "$MYHOME/tmp";
$inet_socket_bind = '127.0.0.1'; $inet_socket_port = 10024;
@local_domains_maps = (1);
@bypass_virus_checks_maps = (1); @bypass_spam_checks_maps = (1);
$forward_method = undef; $notify_method = undef;
$do_syslog = 0; $max_servers = 1;
dkim_key('example.test', 'dkim', '/var/lib/dkim/example.test.pem');
dkim_key('second.test', 'dkim', '/var/lib/dkim/second.test.pem');
@dkim_signature_options_bysender_maps = ( {
  '.example.test' => { d => 'example.test' },
  '.second.test' => { d => 'second.test' },
} );
1;
`;
  await exec.writeFile(mailHostPath(flavor, "/etc/amavis/conf.d/50-user"), amavis);
  await mail(
    exec,
    `sh -ec ${sq(`install -d -o amavis -g amavis /var/lib/amavis/tmp /run/amavis; postfix check; ${flavor === "host" ? "systemctl restart amavis postfix dovecot" : "supervisorctl start amavis postfix dovecot"}`)}`,
  );
  const state = makeFreshState(serverId, domain);
  state.secrets = {
    VMAIL_DB_BIND_PASSWD: dbPassword,
    DOMAIN_ADMIN_PASSWD_PLAIN: "postmaster-fixture",
  };
  state.platformMailbox = {
    email: user,
    password: encrypt(password),
    smtpHost: "mail.example.test",
    smtpPort: 587,
    secure: false,
    updatedAt: new Date().toISOString(),
  };
  state.dnsAcknowledged = true;
  state.ptrAcknowledged = true;
  state.finishedAt = new Date().toISOString();
  await writeState(exec, state);
  await mail(
    exec,
    `sh -ec ${sq(`install -d -o amavis -g amavis /var/lib/amavis/quarantine /var/lib/amavis/db
    printf 'Subject: Retained quarantine\\n\\nQuarantined message\\n' > /var/lib/amavis/quarantine/${source ? "source" : "target"}-marker
    printf filter-state > /var/lib/amavis/db/${source ? "source" : "target"}-marker
    chown -R amavis:amavis /var/lib/amavis/quarantine /var/lib/amavis/db`)}`,
  );
  if (source)
    await exec.exec(
      "install -d /srv; mv /var/vmail /srv/mail-data; ln -s /srv/mail-data /var/vmail",
    );
  if (source)
    await exec.exec(
      "mkdir -p /var/vmail/link-test; printf preserved-link-data > /var/vmail/link-test/a; ln /var/vmail/link-test/a /var/vmail/link-test/b; ln -s a /var/vmail/link-test/relative",
    );
  // Deliver via Dovecot, rather than merely dropping a file into an assumed path.
  if (source) {
    const body =
      "Subject: Preserved attachment\nMIME-Version: 1.0\nContent-Type: multipart/mixed; boundary=fixture\n\n--fixture\nContent-Type: text/plain\n\nPreserve this mail.\n--fixture\nContent-Type: application/octet-stream\nContent-Transfer-Encoding: base64\n\n" +
      Buffer.from(Array.from({ length: 256 }, (_, i) => i)).toString("base64") +
      "\n--fixture--\n";
    const result = await exec.execWithInput!(
      `doveadm save -u ${sq(user)} -m INBOX`,
      Readable.from([body]),
    );
    assert.equal(result.code, 0, result.stderr);
    await exec.exec(`doveadm mailbox create -u ${sq(user)} Archive`);
    assert.equal(
      (
        await exec.execWithInput!(
          `doveadm save -u ${sq(user)} -m Archive`,
          Readable.from(["Subject: Saved folder\n\nArchive message\n"]),
        )
      ).code,
      0,
    );
    await exec.exec(
      "printf 'Subject: Queued mail\n\nHold this message\n' | sendmail -f alice@example.test nobody@example.invalid; postsuper -h ALL",
    );
  }
}

async function waitForRestore(id: string, wanted: string) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const row = await repos.backupRestore.findById(id);
    if (row?.status === wanted) return row;
    assert(
      !["failed", "cancelled", "succeeded"].includes(row?.status ?? ""),
      row?.errorMessage ?? `unexpected ${row?.status}`,
    );
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Restore ${id} did not become ${wanted}`);
}

try {
  await initPlatform(resolvePlatformConfig());
  const org = await seedOrg({ ownsHost: true });
  const ctx = buildBackgroundContext(org);
  const source = await repos.server.create({
    organizationId: org.organizationId,
    name: "This server",
    isLocal: true,
    sshHost: "127.0.0.1",
  });
  const target = await repos.server.create({
    organizationId: org.organizationId,
    name: "Mail destination",
    sshHost: "mail-target",
    sshUser: "root",
    sshAuthMethod: "key",
    sshPrivateKey: encryptSecretField(await readFile("/tmp/mail-test-key", "utf8")),
  });
  await repos.mailServer.markInstalled(source.id, domain);
  await repos.mailServer.markInstalled(target.id, domain);
  await setup(local, source.id, "source-db-password", true);
  await sshManager.withExecutor(target.id, (exec) =>
    setup(
      exec,
      target.id,
      "target-db-password",
      false,
      process.env.MAIL_TEST_TARGET_FLAVOR as MailEngineFlavor,
    ),
  );
  if (process.env.MAIL_TEST_TARGET_FLAVOR === "container") {
    await sshManager.withExecutor(target.id, async (exec) => {
      const paused = await pauseMailDaemons(exec, "container");
      // Supervisor's STOPPED verdict alone is insufficient: the old image's
      // start-fg wrapper can leave Postfix's master and queue writers alive.
      await mail(exec, "if postfix status >/dev/null 2>&1; then exit 1; fi");
      await paused.resume();
      await mail(exec, "postfix status");
    });
  }

  const original = await local.exec(`doveadm fetch -u ${sq(user)} 'mailbox text' all`);
  const keys = await local.exec("sha256sum /var/lib/dkim/*.pem");
  const mailboxHash = sha(original);
  const destination = await seedBackupDestination(org.organizationId, {
    kind: "local",
    endpoint: "/var/lib/openship/backups/mail-test",
  });
  const payload = {
    payloadKind: "custom_command" as const,
    payloadConfig: { mail: { messageData: true, keys: true } },
  };
  const policy = await seedBackupPolicy(destination.id, {
    sourceKind: "mail_server",
    mailServerId: source.id,
    payloadKind: payload.payloadKind,
    payloadConfig: payload.payloadConfig,
  });
  const run = await seedBackupRun(org.organizationId, {
    policyId: policy.id,
    destinationId: destination.id,
    mailServerId: source.id,
    sourceKind: "mail_server",
    status: "queued",
  });
  await backupOrchestrator.execute(run.id);
  const captured = await repos.backupRun.findById(run.id);
  assert.equal(captured?.status, "succeeded", captured?.errorMessage ?? undefined);
  assert((captured?.bytesTransferred ?? 0) > 0);
  const artifacts = captured!.artifacts as Array<{
    key: string;
    metadata: Record<string, unknown>;
  }>;
  assert.deepEqual(artifacts[0]!.metadata.mail, {
    version: 2,
    domain,
    messageData: true,
    keys: true,
  });
  assert(
    !JSON.stringify(captured).includes(password),
    "portable passwords leaked into run metadata",
  );
  assert.equal(
    (await readdir("/root/.openship")).filter((name) => name.startsWith("mail-backup-")).length,
    0,
  );
  await local.exec("systemctl is-active --quiet postfix dovecot amavis");

  async function restore(
    mode: "in_place" | "to_fork",
    runId = run.id,
    wanted = "succeeded",
    forkId = target.id,
  ) {
    const token = randomBytes(24).toString("base64url");
    const prepared = await restoreOrchestrator.beginPrepare({
      runId,
      mode,
      ...(mode === "to_fork" ? { forkMailServerId: forkId } : {}),
      confirmationToken: token,
      trigger: { source: "manual", userId: org.userId },
    });
    await waitForRestore(prepared.restoreId, "prepared");
    await restoreOrchestrator.apply(ctx, prepared.restoreId, prepared.confirmationToken);
    return waitForRestore(prepared.restoreId, wanted);
  }
  await local.exec(`doveadm expunge -u ${sq(user)} mailbox '*' all`);
  await sql(
    local,
    "DELETE FROM alias; DELETE FROM sender_bcc_user; UPDATE mail_app.notes SET body='changed'",
  );
  await restore("in_place");
  await local.exec(
    'test -L /var/vmail; test /var/vmail/link-test/a -ef /var/vmail/link-test/b; test "$(readlink /var/vmail/link-test/relative)" = a',
  );
  assert.equal(
    sha(await local.exec(`doveadm fetch -u ${sq(user)} 'mailbox text' all`)),
    mailboxHash,
  );
  assert.equal((await sql(local, "SELECT count(*) FROM alias")).trim(), "1");
  assert.equal((await sql(local, "SELECT body FROM mail_app.notes")).trim(), "source-note");
  await restore("to_fork");
  await sshManager.withExecutor(target.id, async (exec) => {
    assert.equal(
      sha(await mail(exec, `doveadm fetch -u ${sq(user)} 'mailbox text' all`)),
      mailboxHash,
    );
    assert.equal((await mail(exec, "sha256sum /var/lib/dkim/*.pem")).trim(), keys.trim());
    assert.equal((await sql(exec, "SELECT body FROM mail_app.notes")).trim(), "source-note");
    assert.equal((await sql(exec, "SELECT count(*) FROM sender_bcc_user")).trim(), "1");
    for (const db of ["amavisd", "iredapd", "fail2ban"])
      assert.equal((await sql(exec, "SELECT body FROM restored_rows", db)).trim(), `source-${db}`);
    const state = await readState(exec, { strict: true });
    assert.equal(state?.serverId, target.id);
    assert.equal(state?.secrets.VMAIL_DB_BIND_PASSWD, "target-db-password");
    assert.equal(decrypt(state!.platformMailbox!.password), password);
    assert.equal(state?.dnsAcknowledged, false);
    assert(state?.additionalDomains?.["second.test"]?.records.dkim);
    assert(
      (await mailFile(exec, "/etc/dovecot/backup-test-sql.conf")).includes("target-db-password"),
    );
    assert(
      (await mail(exec, `doveadm auth test ${sq(user)} ${sq(password)}`)).includes(
        "auth succeeded",
      ),
    );
    assert((await mail(exec, "postqueue -p")).includes("nobody@example.invalid"));
    await mail(
      exec,
      'test /var/vmail/link-test/a -ef /var/vmail/link-test/b; test "$(readlink /var/vmail/link-test/relative)" = a',
    );
    assert(
      (await mail(exec, "cat /var/lib/amavis/quarantine/source-marker")).includes(
        "Quarantined message",
      ),
    );
    assert.equal((await mail(exec, "cat /var/lib/amavis/db/source-marker")).trim(), "filter-state");
    await mail(exec, "test ! -e /var/lib/amavis/quarantine/target-marker");
    if (flavorFor(exec) === "host")
      await exec.exec("systemctl is-active --quiet postfix dovecot amavis");
    else
      assert(
        (await mail(exec, "supervisorctl status postfix dovecot amavis"))
          .split("\n")
          .every((line) => line.includes("RUNNING")),
      );
    assert((await repos.mailServer.get(target.id))?.installedAt);
  });
  if (process.env.MAIL_TEST_TARGET_FLAVOR === "container") {
    const reversePolicy = await seedBackupPolicy(destination.id, {
      sourceKind: "mail_server",
      mailServerId: target.id,
      payloadKind: payload.payloadKind,
      payloadConfig: payload.payloadConfig,
    });
    const reverseRun = await seedBackupRun(org.organizationId, {
      policyId: reversePolicy.id,
      destinationId: destination.id,
      mailServerId: target.id,
      sourceKind: "mail_server",
      status: "queued",
    });
    await backupOrchestrator.execute(reverseRun.id);
    const reverse = await repos.backupRun.findById(reverseRun.id);
    assert.equal(reverse?.status, "succeeded", reverse?.errorMessage ?? undefined);
    await local.exec(`doveadm expunge -u ${sq(user)} mailbox '*' all`);
    await restore("to_fork", reverseRun.id, "succeeded", source.id);
    assert.equal(
      sha(await local.exec(`doveadm fetch -u ${sq(user)} 'mailbox text' all`)),
      mailboxHash,
    );
    assert.equal(
      (await readState(local, { strict: true }))?.secrets.VMAIL_DB_BIND_PASSWD,
      "source-db-password",
    );
  }
  // A requested secret cannot silently disappear, and failure must undo the
  // writer pause even though the archive stream failed before upload completed.
  await local.exec("mv /usr/bin/pg_dump /usr/bin/pg_dump-held");
  const failedCapture = await seedBackupRun(org.organizationId, {
    policyId: policy.id,
    destinationId: destination.id,
    mailServerId: source.id,
    sourceKind: "mail_server",
    status: "queued",
  });
  await backupOrchestrator.execute(failedCapture.id);
  assert.equal((await repos.backupRun.findById(failedCapture.id))?.status, "failed");
  await local.exec(
    "systemctl is-active --quiet postfix dovecot amavis; mv /usr/bin/pg_dump-held /usr/bin/pg_dump",
  );
  assert.equal(
    (await readdir("/root/.openship")).filter((name) => name.startsWith("mail-backup-")).length,
    0,
  );

  // A syntactically valid archive whose database replay fails must roll back
  // that database, report the failed restore, and keep mail stopped for review.
  const archive = join(destination.endpoint!, artifacts[0]!.key);
  const broken = join(destination.endpoint!, "broken.sql.tar.zst");
  await local.exec(`mkdir -m 0700 /tmp/mail-broken; zstd -dc ${sq(archive)} | tar -x -C /tmp/mail-broken
    printf '\\nSELECT nonexistent_restore_column;\\n' >> /tmp/mail-broken/vmail.sql
    tar -c -C /tmp/mail-broken . | zstd -c > ${sq(broken)}`);
  await sql(local, "UPDATE mail_app.notes SET body='must-survive-failed-restore'");
  const brokenRun = await seedBackupRun(org.organizationId, {
    policyId: policy.id,
    destinationId: destination.id,
    mailServerId: source.id,
    sourceKind: "mail_server",
    status: "succeeded",
    artifacts: [
      {
        ...artifacts[0]!,
        key: "broken.sql.tar.zst",
        sizeBytes: (await stat(broken)).size,
        sha256: createHash("sha256")
          .update(await readFile(broken))
          .digest("hex"),
      },
    ],
  });
  const failedRestore = await restore("in_place", brokenRun.id, "failed");
  assert.match(failedRestore.errorMessage ?? "", /nonexistent_restore_column/);
  assert.equal(
    (await sql(local, "SELECT body FROM mail_app.notes")).trim(),
    "must-survive-failed-restore",
  );
  assert.equal((failedRestore.meta as Record<string, unknown>).serviceLeftStopped, true);
  assert.equal((failedRestore.meta as Record<string, unknown>).partialWrite, true);
  assert.equal((await local.exec("systemctl is-active dovecot || true")).trim(), "inactive");
  assert.equal(
    (await readdir("/root/.openship")).filter((name) => name.startsWith("mail-backup-")).length,
    0,
  );
  // Explicit retry repairs the stopped partial restore and resumes only services
  // that were running when it was requested.
  await local.exec("systemctl start postfix dovecot amavis");
  await restore("in_place");
  assert.equal(
    sha(await local.exec(`doveadm fetch -u ${sq(user)} 'mailbox text' all`)),
    mailboxHash,
  );
  console.log(
    "MAIL_BACKUP_ROUNDTRIP_OK: local capture, in-place restore, SSH migration, messages/attachments/folders, queue, all mail tables, keys, destination credentials, registration, failed capture recovery and failed SQL rollback",
  );
} finally {
  await local.dispose();
  await sshManager.destroy();
  resetPlatform();
  await closeDb();
}
