import "./_setup-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  writeFile: vi.fn(),
  readState: vi.fn(),
  writeState: vi.fn(),
  readFile: vi.fn(),
  removeFile: vi.fn(),
  target: vi.fn(),
  installed: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  dkim: vi.fn(),
  dns: vi.fn(),
  rows: vi.fn(),
  relay: vi.fn(),
  disableRelay: vi.fn(),
}));
vi.mock("@repo/db", async (original) => ({
  ...(await original<typeof import("@repo/db")>()),
  repos: { mailServer: { get: mocks.target, markInstalled: mocks.installed } },
}));
vi.mock("@repo/platform/engine/lib/openship-server-store", () => ({
  OPENSHIP_DIR: "/root/.openship",
  HOST_STATE_DIR: "/root/.openship",
  readOpenshipFile: mocks.readFile,
  removeOpenshipFile: mocks.removeFile,
  writeOpenshipFile: mocks.writeFile,
}));
vi.mock("@repo/platform/engine/modules/mail/mail-state", async (original) => ({
  ...(await original<typeof import("@repo/platform/engine/modules/mail/mail-state")>()),
  readState: mocks.readState,
  writeState: mocks.writeState,
}));
vi.mock("@repo/platform/engine/modules/mail/mail-engine", async (original) => ({
  ...(await original<typeof import("@repo/platform/engine/modules/mail/mail-engine")>()),
  resolveMailFlavor: async () => "host",
  pauseMailDaemons: mocks.pause,
}));
vi.mock("@repo/platform/engine/modules/mail/mail.service", () => ({
  provisionDomainDkim: mocks.dkim,
  stepDkimKeys: mocks.dns,
}));
vi.mock("@repo/platform/engine/modules/mail/admin/psql-runner", () => ({ queryRows: mocks.rows }));
vi.mock("@repo/platform/engine/modules/mail/admin/domain-dns.service", () => ({
  buildDomainDnsRecords: (_primary: string, domain: string, dkim: string) => ({
    mx: { value: domain },
    dkim: { value: dkim },
  }),
}));
vi.mock("@repo/platform/engine/modules/mail/admin/outbound-relay.service", () => ({
  configureOutboundRelay: mocks.relay,
  disableOutboundRelay: mocks.disableRelay,
}));
import { BareRuntime, LocalExecutor } from "@repo/adapters";
import { makeFreshState } from "@repo/platform/engine/modules/mail/mail-state";
import { exportMailState } from "@repo/platform/engine/modules/mail/backup-state";
import {
  prepareMailRestore,
  prepareMailBackup,
  readMailBackupMetadata,
} from "@repo/platform/engine/modules/mail/backup-lifecycle";
import { backupScript } from "./backup-script";

const metadata = { version: 2 as const, domain: "example.test", messageData: true, keys: true };
const runtime = () => new BareRuntime({ executor: new LocalExecutor() });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.target.mockResolvedValue({ domain: metadata.domain });
  mocks.readState.mockResolvedValue(makeFreshState("target", metadata.domain));
  mocks.readFile.mockResolvedValue(
    JSON.stringify(exportMailState(makeFreshState("source", metadata.domain))),
  );
  mocks.pause.mockResolvedValue({ resume: mocks.resume, stopped: true });
  mocks.rows.mockResolvedValue([{ domain: metadata.domain }, { domain: "second.test" }]);
  mocks.dkim.mockImplementation(async (_exec, domain) => `public-key:${domain}`);
  mocks.dns.mockResolvedValue({
    stepId: 6,
    success: true,
    message: "DNS",
    data: { dnsRecords: { a: { value: "192.0.2.2" } } },
  });
});
describe("mail restore uses the destination's normal configuration paths", () => {
  it("reconciles DKIM through normal setup, retains target identity and registers completion", async () => {
    const operation = await prepareMailRestore(runtime(), "target", "restore-1", metadata);
    const script = backupScript(operation.restoreCommand);
    // Source amavis DB passwords/paths must not replace the destination config.
    expect(script).not.toContain('cp -a "$tmp/keys/amavis');
    await operation.finalize();
    expect(mocks.dkim).toHaveBeenCalledWith(expect.anything(), "second.test", { reload: false });
    const state = mocks.writeState.mock.calls.at(-1)![1];
    expect(state.serverId).toBe("target");
    expect(state.dnsAcknowledged).toBe(false);
    expect(state.additionalDomains["second.test"].records.dkim.value).toBe(
      "public-key:second.test",
    );
    expect(mocks.resume).toHaveBeenCalledOnce();
    expect(mocks.installed).toHaveBeenCalledWith("target", metadata.domain);
    expect(mocks.disableRelay).toHaveBeenCalledWith(expect.anything(), { reload: false });
  });
  it("rejects a different target domain before pausing or modifying it", async () => {
    mocks.target.mockResolvedValue({ domain: "unrelated.test" });
    await expect(prepareMailRestore(runtime(), "target", "restore-2", metadata)).rejects.toThrow(
      "primary domain",
    );
    expect(mocks.pause).not.toHaveBeenCalled();
    expect(mocks.writeState).not.toHaveBeenCalled();
  });

  it("binds restored on-server state to the destination's current registration", async () => {
    mocks.readState.mockResolvedValue(makeFreshState("previous-controller-id", metadata.domain));
    const operation = await prepareMailRestore(runtime(), "target", "restore-adopted", metadata);
    await operation.finalize();
    expect(mocks.writeState.mock.calls.at(-1)![1].serverId).toBe("target");
  });
  it("leaves mail stopped and does not report completion when configuration recovery fails", async () => {
    const operation = await prepareMailRestore(runtime(), "target", "restore-3", metadata);
    mocks.dkim.mockRejectedValue(new Error("DKIM key unreadable"));
    await expect(operation.finalize()).rejects.toThrow("DKIM key unreadable");
    expect(mocks.resume).not.toHaveBeenCalled();
    expect(mocks.installed).not.toHaveBeenCalled();
    await operation.cleanup();
    expect(mocks.removeFile).toHaveBeenCalledWith(expect.anything(), "mail-backup-restore-3.json");
  });
  it("uses recorded commands for legacy archives and refuses an unknown format", () => {
    expect(readMailBackupMetadata({ restoreCommand: "recorded legacy command" })).toBeNull();
    expect(() => readMailBackupMetadata({ mail: { ...metadata, version: 99 } })).toThrow(
      "unsupported",
    );
  });
});

describe("mail capture preflight", () => {
  it("does not pause delivery when a required key/configuration check fails", async () => {
    mocks.rows.mockResolvedValue([{ storagebasedirectory: "/var/vmail" }]);
    const exec = vi.fn().mockRejectedValue(new Error("primary key missing"));
    const host = new BareRuntime({ executor: { exec } as never });
    await expect(prepareMailBackup(host, "capture-1", {})).rejects.toThrow("primary key missing");
    expect(mocks.pause).not.toHaveBeenCalled();
    expect(mocks.removeFile).toHaveBeenCalledWith(expect.anything(), "mail-backup-capture-1.json");
  });
  it("refuses to claim a full backup of a custom mailbox root it would not capture", async () => {
    mocks.rows.mockResolvedValue([{ storagebasedirectory: "/srv/external-mail" }]);
    await expect(prepareMailBackup(runtime(), "capture-2", {})).rejects.toThrow(
      "outside /var/vmail",
    );
    expect(mocks.pause).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });
});
