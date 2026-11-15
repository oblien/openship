import "./_setup-env";
import { describe, expect, it } from "vitest";
import { buildMailBackupPayload } from "@repo/platform/engine/modules/mail/backup-plan";
import { MAIL_CONTAINER_MOUNTS } from "@repo/adapters";
import { backupScript } from "./backup-script";

const flags = { messageData: true, keys: true };
describe("mail archive topology", () => {
  it("runs database tools in the sidecar and repairs mail ownership in the engine", () => {
    const plan = buildMailBackupPayload("example.test", flags, "container").payloadConfig;
    const capture = backupScript(plan.produceCommand);
    const restore = backupScript(plan.restoreCommand);
    expect(capture).toContain("docker exec openship-mail-db pg_dump -U postgres");
    expect(restore).toContain("docker exec -i openship-mail-db psql -U postgres");
    expect(restore).toContain("--single-transaction");
    expect(restore).toContain("docker exec openship-mail chown -R -H vmail:vmail /var/vmail");
    expect(restore).not.toContain("sudo -u postgres");
    expect(restore).not.toMatch(/chown[^\n]*\|\| true/);
  });
  it("uses native database tools on bare hosts", () => {
    const plan = buildMailBackupPayload("example.test", flags, "host").payloadConfig;
    expect(backupScript(plan.produceCommand)).toContain("sudo -u postgres pg_dump");
    expect(backupScript(plan.restoreCommand)).toContain("sudo -u postgres psql");
    expect(backupScript(plan.restoreCommand)).not.toContain("docker exec");
  });
  it("captures complete mail roots through the installation's canonical mount map", () => {
    const plan = buildMailBackupPayload("example.test", flags, "container").payloadConfig;
    const capture = backupScript(plan.produceCommand);
    const restore = backupScript(plan.restoreCommand);
    for (const path of ["/var/vmail", "/var/lib/dkim"]) {
      const mount = MAIL_CONTAINER_MOUNTS.find((entry) => entry.container === path)!;
      expect(mount).toBeDefined();
      // tar addresses a root through -C parent + basename; restore uses its full path.
      expect(restore).toContain(mount.host);
    }
    expect(capture).not.toContain("vmail1"); // Other stores/sieve/quarantine must survive too.
    expect(capture).toContain("--clean --if-exists --no-owner");
    expect(capture).not.toContain("--table=");
  });
});
