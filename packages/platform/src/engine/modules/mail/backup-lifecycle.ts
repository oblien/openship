import { BareRuntime, type CommandExecutor, type RuntimeAdapter } from "@repo/adapters";
import { repos } from "@repo/db";
import { decrypt } from "../../lib/encryption";
import {
  OPENSHIP_DIR,
  readOpenshipFile,
  removeOpenshipFile,
  writeOpenshipFile,
} from "../../lib/openship-server-store";
import { buildMailBackupPayload, mailBackupFlags, type MailBackupFlags } from "./backup-plan";
import { exportMailState, importMailState, type PortableMailState } from "./backup-state";
import { readState, recordStep, writeState, type MailServerState } from "./mail-state";
import { pauseMailDaemons, resolveMailFlavor } from "./mail-engine";
import { provisionDomainDkim, stepDkimKeys } from "./mail.service";
import { queryRows } from "./admin/psql-runner";
import { buildDomainDnsRecords } from "./admin/domain-dns.service";
import { configureOutboundRelay, disableOutboundRelay } from "./admin/outbound-relay.service";

export interface MailBackupMetadata extends MailBackupFlags {
  version: 2;
  domain: string;
}

export function readMailBackupMetadata(
  metadata: Record<string, unknown>,
): MailBackupMetadata | null {
  const mail = metadata.mail as Partial<MailBackupMetadata> | undefined;
  if (!Object.hasOwn(metadata, "mail")) return null; // Legacy recorded command.
  if (
    !mail ||
    typeof mail !== "object" ||
    mail.version !== 2 ||
    typeof mail.domain !== "string" ||
    typeof mail.keys !== "boolean" ||
    typeof mail.messageData !== "boolean"
  )
    throw new Error("This mail backup has unsupported or invalid archive metadata");
  return mail as MailBackupMetadata;
}

function stagingName(id: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid mail backup operation id");
  return `mail-backup-${id}.json`;
}

function commandExecutor(runtime: RuntimeAdapter | null): CommandExecutor {
  if (!(runtime instanceof BareRuntime)) throw new Error("Mail backups require a host runtime");
  return runtime.commandExecutor;
}

/** Per-run preparation is shared by scheduled/manual mail captures. Never put
 * portable credentials in the policy, artifact metadata or API progress response. */
export async function prepareMailBackup(
  runtime: RuntimeAdapter | null,
  runId: string,
  config: unknown,
) {
  const exec = commandExecutor(runtime);
  const state = await readState(exec, { strict: true });
  if (!state) throw new Error("The mail server has no saved configuration to back up");
  const flags = mailBackupFlags(config);
  const flavor = await resolveMailFlavor(exec);
  if (flags.messageData) {
    const stores = await queryRows<{ storagebasedirectory: string }>(
      exec,
      "SELECT DISTINCT storagebasedirectory FROM mailbox",
    );
    if (stores.some((store) => store.storagebasedirectory?.replace(/\/+$/, "") !== "/var/vmail")) {
      throw new Error(
        "This mail server uses a mailbox storage root outside /var/vmail. Back up that custom store before migrating; a full managed-mail backup cannot omit it.",
      );
    }
  }
  const name = stagingName(runId);
  let paused: Awaited<ReturnType<typeof pauseMailDaemons>> | undefined;
  const cleanup = async () => {
    try {
      await paused?.resume();
    } finally {
      await removeOpenshipFile(exec, name);
    }
  };
  try {
    if (flags.keys) await writeOpenshipFile(exec, name, JSON.stringify(exportMailState(state)));
    const payload = buildMailBackupPayload(state.domain, flags, flavor, {
      ...(flags.keys ? { statePath: `${OPENSHIP_DIR}/${name}` } : {}),
    });
    await exec.exec(payload.preflightCommand);
    if (flags.messageData) paused = await pauseMailDaemons(exec, flavor);
    return {
      payload,
      metadata: { version: 2, domain: state.domain, ...flags } satisfies MailBackupMetadata,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export async function assertMailRestoreTarget(serverId: string, metadata: MailBackupMetadata) {
  const target = await repos.mailServer.get(serverId);
  if (!target || target.domain !== metadata.domain)
    throw new Error(
      `Prepare the target mail server with the backup's primary domain (${metadata.domain}) before restoring. No data was changed.`,
    );
}

/** Data is streamed by the normal backup producer. This finalizer restores its
 * portable server state and uses the same DKIM, DNS and relay paths as setup. */
export async function prepareMailRestore(
  runtime: RuntimeAdapter | null,
  serverId: string,
  restoreId: string,
  metadata: MailBackupMetadata,
) {
  await assertMailRestoreTarget(serverId, metadata);
  const exec = commandExecutor(runtime);
  const savedTarget = await readState(exec, { strict: true });
  if (!savedTarget) throw new Error("Run mail setup on the target before restoring its data");
  if (savedTarget.domain !== metadata.domain)
    throw new Error("The target mail configuration has a different primary domain");
  // An adopted server can still carry its former controller's id on disk.
  const target = { ...savedTarget, serverId };
  const flavor = await resolveMailFlavor(exec);
  const name = stagingName(restoreId);
  // Remove a leftover handoff before a retry; missing configuration must never
  // accidentally reuse data left by a different attempt.
  await removeOpenshipFile(exec, name);
  const payload = buildMailBackupPayload(metadata.domain, metadata, flavor, {
    restoreStatePath: `${OPENSHIP_DIR}/${name}`,
  });
  const paused = await pauseMailDaemons(exec, flavor);
  return {
    resume: paused.resume,
    get stopped() {
      return paused.stopped;
    },
    restoreCommand: payload.payloadConfig.restoreCommand,
    cleanup: () => removeOpenshipFile(exec, name),
    finalize: async () => {
      // Without saved credentials, the old target's cached mailbox passwords no
      // longer correspond to the restored account hashes. Normal mailbox setup
      // can recreate these managed credentials when next needed.
      const { DOMAIN_ADMIN_PASSWD_PLAIN: _oldPostmaster, ...targetSecrets } = target.secrets;
      let state: MailServerState = {
        ...target,
        secrets: targetSecrets,
        platformMailbox: undefined,
        testMailboxes: undefined,
        additionalDomains: undefined,
      };
      if (metadata.keys) {
        const raw = await readOpenshipFile(exec, name, { strict: true });
        if (!raw)
          throw new Error("The restored archive did not contain its portable mail configuration");
        state = importMailState(JSON.parse(raw) as PortableMailState, target);
        await writeState(exec, state);
      }
      const domains = await queryRows<{ domain: string }>(
        exec,
        "SELECT domain FROM domain ORDER BY domain",
      );
      if (!domains.some(({ domain }) => domain === state.domain))
        throw new Error("The restored mail database has no primary domain");
      const additionalDomains: NonNullable<typeof state.additionalDomains> = {};
      for (const { domain } of domains) {
        const dkim = await provisionDomainDkim(exec, domain, { reload: false });
        if (domain !== state.domain)
          additionalDomains[domain] = {
            ...state.additionalDomains?.[domain],
            records: buildDomainDnsRecords(state.domain, domain, dkim),
            acknowledgedAt: null,
            createdAt: state.additionalDomains?.[domain]?.createdAt ?? new Date().toISOString(),
          };
      }
      const dns = await stepDkimKeys(exec, state.domain, () => {});
      if (!dns.success || !dns.data?.dnsRecords) throw new Error(dns.message);
      state = {
        ...recordStep(state, dns),
        additionalDomains,
        dnsRecords: dns.data.dnsRecords as Record<string, unknown>,
        dnsAcknowledged: false,
        ptrAcknowledged: false,
        finishedAt: new Date().toISOString(),
      };
      await writeState(exec, state);
      if (state.outboundRelay?.enabled) {
        const relay = state.outboundRelay;
        await configureOutboundRelay(
          exec,
          { ...relay, password: decrypt(relay.passwordEncrypted) },
          { reload: false },
        );
      } else if (metadata.keys) {
        await disableOutboundRelay(exec, { reload: false });
      }
      await removeOpenshipFile(exec, name);
      await paused.resume();
      await repos.mailServer.markInstalled(serverId, state.domain);
    },
  };
}
