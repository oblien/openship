import "./_setup-env";
import { describe, expect, it } from "vitest";
import { buildMailBackupPayload } from "@repo/platform/engine/modules/mail/backup-plan";
import { backupScript } from "./backup-script";

describe("mail backup secret handling", () => {
  it("runs the entire capture as root, with private staging and mandatory requested secrets", () => {
    const command = buildMailBackupPayload("example.test", { messageData: true, keys: true })
      .payloadConfig.produceCommand;
    const script = backupScript(command);
    expect(script).toContain("umask 077");
    expect(script).toContain("test -d '/var/lib/dkim'");
    expect(script).toContain("test -s '/root/.openship/mail-state.json'");
    expect(script).toContain("cp -a '/var/lib/dkim'");
    expect(script).toContain("cp -a '/root/.openship/mail-state.json'");
    expect(script).not.toContain("|| true");
    expect(script).toContain("trap 'rm -rf \"$tmp\"' EXIT");
  });
  it("uses the per-run portable file, without embedding its contents in commands", () => {
    const command = buildMailBackupPayload(
      "example.test",
      { messageData: false, keys: true },
      "host",
      { statePath: "/root/.openship/mail-backup-run.json" },
    ).payloadConfig.produceCommand;
    expect(backupScript(command)).toContain("cp -a '/root/.openship/mail-backup-run.json'");
    expect(backupScript(command)).not.toContain("cp -a '/root/.openship/mail-state.json'");
  });
  it("propagates both tar and compressor failures", () => {
    const script = backupScript(
      buildMailBackupPayload("example.test", { messageData: true, keys: true }).payloadConfig
        .produceCommand,
    );
    expect(script).toContain("openship: tar (staging the mail archive) failed with status");
    expect(script).toContain("openship: the compressor 'zstd' failed with status");
  });
  it("does not read private configuration when explicitly excluded", () => {
    const script = backupScript(
      buildMailBackupPayload("example.test", { messageData: false, keys: false }).payloadConfig
        .produceCommand,
    );
    expect(script).not.toContain("/var/lib/dkim");
    expect(script).not.toContain("/root/.openship/mail-state.json");
    expect(script).not.toContain("-C '/var' vmail");
  });
});
