import { describe, expect, it } from "vitest";

import { buildMailBackupPayload } from "../../../src/modules/mail/admin/backup-plan";

/**
 * A `keys: true` backup must not be able to succeed without the keys.
 *
 * Every secret this archive exists to carry lives on a root-owned path — `/root/.openship`
 * is mode 0700, `/var/lib/dkim` holds private keys, and `/var/vmail` is vmail:vmail 0700 —
 * while `produceCommand` runs through the BARE ssh executor, unelevated. The reads were
 * written as `[ -f … ] && cp … || true`, which on a host Openship logs into as a sudoer
 * rather than as root cannot even stat the path: the test fails for lack of privilege,
 * `|| true` absorbs it, and the run exits 0 recording `keys: true` on an archive with no
 * keys in it. mail-state.json is the only copy of the DKIM state and the encrypted
 * mailbox/admin credentials, so the artifact is a disaster-recovery archive that isn't one.
 *
 * These assert the two halves of the fix — read as root, and don't swallow the failure —
 * against the emitted script, which is the only observable: the shell runs on a mail host.
 */

const SECRET_READS = [
  { what: "DKIM private keys", path: "/var/lib/dkim" },
  { what: "mail-state.json (DKIM state + encrypted credentials)", path: "/root/.openship/mail-state.json" },
];

describe("mail backup cannot silently omit the secrets it was asked for", () => {
  const produce = (keys: boolean) =>
    buildMailBackupPayload("example.com", { messageData: false, keys }).payloadConfig
      .produceCommand;

  it.each(SECRET_READS)("reads $what with sudo, not as the login user", ({ path }) => {
    const script = produce(true);
    const line = script.split("\n").find((l) => l.includes(path));

    expect(line, `no line reads ${path}`).toBeDefined();
    expect(line).toContain("sudo -n");
  });

  it.each(SECRET_READS)("does not absorb a failed read of $what", ({ path }) => {
    // `|| true` on these is the whole defect: it converts "could not read the secret" into
    // "the host does not have one", and the two are not the same answer.
    const line = produce(true)
      .split("\n")
      .find((l) => l.includes(path) && l.includes("cp "));

    expect(line, `no copy of ${path}`).toBeDefined();
    expect(line).not.toContain("|| true");
  });

  it("distinguishes an absent secret from an unreadable one", () => {
    const script = produce(true);
    // Absence must still skip — a box with no amavis config is a gap in the archive, not a
    // failed backup. The `test` is what expresses that, so it has to be there AND be
    // privileged; a `[ -f ]` under the login user answers "absent" for both cases.
    expect(script).toContain("sudo -n test -f /root/.openship/mail-state.json");
    expect(script).toContain("sudo -n test -d /var/lib/dkim");
    expect(script).not.toMatch(/^\s*\[ -[fd] \/(root|var\/lib\/dkim)/m);
  });

  it("tars as root, so it can read back what it staged as root", () => {
    // Not cosmetic: `sudo -n cp -a` stages root-owned 0600 files. An unprivileged tar would
    // fail to read them — and `zstd` masks tar's exit status in this pipeline, so the run
    // would still exit 0 with a truncated artifact. Same reason /var/vmail needs it.
    for (const messageData of [false, true]) {
      const script = buildMailBackupPayload("example.com", { messageData, keys: true })
        .payloadConfig.produceCommand;
      const tar = script.split("\n").find((l) => l.includes("tar -c"));
      expect(tar, `no tar line (messageData: ${messageData})`).toBeDefined();
      expect(tar).toMatch(/^sudo -n tar -c/);
    }
  });

  it("stages nothing privileged when keys were not requested", () => {
    // The contrast case: without it, a fix that sudo'd unconditionally would pass the
    // assertions above while changing what a keys:false backup touches.
    const script = produce(false);
    for (const { path } of SECRET_READS) expect(script).not.toContain(path);
  });
});
