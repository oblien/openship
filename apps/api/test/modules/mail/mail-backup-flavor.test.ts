/**
 * The backup shell has to be written for the topology it will run on (GH-563).
 *
 * The produce/restore commands are BAKED here and executed later by the generic
 * custom_command producer over a bare SSH executor, which knows nothing about mail. So a
 * containerized engine cannot be discovered at run time - the plan has to already say
 * `docker exec`. It did not: it issued `sudo -u postgres pg_dump` and
 * `chown -R vmail:vmail` on the host, where on a container box there is no `postgres`
 * user, no `pg_dump`, and no `vmail`. The dump aborted the whole backup under `set -e`,
 * and on restore the chown was masked by `|| true`, leaving maildirs root-owned and
 * unreadable by Dovecot while the run reported success.
 */
import { describe, expect, it } from "vitest";
import { buildMailBackupPayload } from "../../../src/modules/mail/admin/backup-plan";

const FLAGS = { messageData: true, keys: true };

describe("mail backup plan targets the right topology", () => {
  it("[container] runs Postgres in the sidecar and chown in the engine", () => {
    const { payloadConfig } = buildMailBackupPayload("example.com", FLAGS, "container");
    const { produceCommand: produce, restoreCommand: restore } = payloadConfig;

    // Nothing may assume a host-side postgres or vmail user.
    expect(produce).not.toContain("sudo -u postgres");
    expect(restore).not.toContain("sudo -u postgres");
    expect(produce).toContain("docker exec openship-mail-db pg_dump -U postgres");

    // The dump file is staged in the producer's $tmp ON THE HOST, which the sidecar
    // cannot see - so the replay must arrive over stdin, and docker exec needs -i.
    expect(restore).toContain("docker exec -i openship-mail-db psql -U postgres");
    expect(restore).not.toMatch(/psql[^\n]*-f "\$tmp/);

    // Ownership must be applied where the vmail user exists: the ENGINE, not the sidecar,
    // and not the host.
    expect(restore).toContain("docker exec openship-mail chown -R vmail:vmail /var/vmail/vmail1");
    // ...and a failure there must not be swallowed - root-owned maildirs are unreadable.
    expect(restore).not.toMatch(/chown -R vmail:vmail [^\n]*\|\| true/);

    // Daemons re-read via supervisord in the container; systemctl does not exist there.
    expect(restore).toContain("supervisorctl restart postfix dovecot amavis");
    expect(restore).not.toContain("systemctl reload");
  });

  it("[host] keeps the legacy sudo/systemctl form", () => {
    const { payloadConfig } = buildMailBackupPayload("example.com", FLAGS, "host");
    const { produceCommand: produce, restoreCommand: restore } = payloadConfig;

    expect(produce).toContain("sudo -u postgres pg_dump -d vmail");
    expect(restore).toContain("sudo -u postgres psql");
    expect(restore).toContain("chown -R vmail:vmail /var/vmail/vmail1");
    expect(restore).toContain("systemctl reload postfix dovecot");
    expect(produce).not.toContain("docker exec");
    expect(restore).not.toContain("docker exec");
  });

  it("proves sudo works before relying on it to tell absent from unreadable", () => {
    // The `sudo -n test`/`sudo -n cp` reads below only distinguish those two cases if sudo
    // is known to work. That used to be guaranteed by `sudo -u postgres pg_dump` running
    // first under `set -e`; routing the dump through the sidecar removed the guarantee on
    // container boxes, so the probe has to be explicit - otherwise a failing `test` reads
    // as absence and the archive is stamped `keys: true` with no keys in it.
    for (const flavor of ["container", "host"] as const) {
      const { payloadConfig } = buildMailBackupPayload("example.com", FLAGS, flavor);
      const produce = payloadConfig.produceCommand;
      expect(produce).toContain("sudo -n true");
      expect(produce.indexOf("sudo -n true")).toBeLessThan(produce.indexOf("sudo -n test -d /var/lib/dkim"));
    }
  });

  it("keeps the maildir tar on the host, where the bind mount is", () => {
    // /var/vmail is a bind mount, so tar reads it in place on either topology - moving it
    // into the container would need the archive to come back out again.
    for (const flavor of ["container", "host"] as const) {
      const { payloadConfig } = buildMailBackupPayload("example.com", FLAGS, flavor);
      expect(payloadConfig.produceCommand).toContain('sudo -n tar -c -C "$tmp" . -C /var/vmail vmail1');
    }
  });
});
