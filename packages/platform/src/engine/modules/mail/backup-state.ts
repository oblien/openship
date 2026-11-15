import type { Encryption } from "@repo/platform";
import { decrypt, encrypt } from "../../lib/encryption";
import type { MailServerState } from "./mail-state";

export interface PortableMailState {
  version: 1;
  encoding: "plaintext";
  state: MailServerState;
}

function mapCredentials(
  state: MailServerState,
  transform: (value: string, legacy: boolean) => string,
) {
  const result = structuredClone(state);
  if (result.platformMailbox)
    result.platformMailbox.password = transform(result.platformMailbox.password, true);
  for (const mailbox of Object.values(result.testMailboxes ?? {}))
    mailbox.password = transform(mailbox.password, true);
  if (result.outboundRelay?.passwordEncrypted)
    result.outboundRelay.passwordEncrypted = transform(
      result.outboundRelay.passwordEncrypted,
      false,
    );
  return result;
}

/** The archive carries portable values; no source-instance cipher is copied to a new install. */
export function exportMailState(
  state: MailServerState,
  cipher: Pick<Encryption, "decrypt"> = { decrypt },
): PortableMailState {
  const portable = mapCredentials(state, (value, legacy) => {
    if (!value) return value;
    // Old generated mailbox passwords are shorter than an AES-GCM envelope.
    // A full-size envelope that cannot be decrypted must fail capture explicitly.
    if (legacy && Buffer.from(value, "base64").length < 32) return value;
    return cipher.decrypt(value);
  });
  // These belong to the source machine, and are never applied on the target.
  // Carry only the postmaster password corresponding to the restored account.
  portable.secrets = state.secrets.DOMAIN_ADMIN_PASSWD_PLAIN
    ? { DOMAIN_ADMIN_PASSWD_PLAIN: state.secrets.DOMAIN_ADMIN_PASSWD_PLAIN }
    : {};
  portable.completedSteps = {};
  portable.logs = [];
  delete portable.webmail;
  return { version: 1, encoding: "plaintext", state: portable };
}

/** Keep the destination's engine identity and DB-role credentials, while restoring
 * the mailbox/relay credentials that correspond to the restored SQL account hashes. */
export function importMailState(
  portable: PortableMailState,
  target: MailServerState,
  cipher: Pick<Encryption, "encrypt"> = { encrypt },
): MailServerState {
  if (
    portable?.version !== 1 ||
    portable.encoding !== "plaintext" ||
    portable.state?.version !== 1 ||
    portable.state.domain !== target.domain
  )
    throw new Error("The mail backup configuration does not match the target's primary domain");
  const restored = mapCredentials(portable.state, (value) =>
    value ? cipher.encrypt(value) : value,
  );
  const { DOMAIN_ADMIN_PASSWD_PLAIN: _oldPostmaster, ...targetSecrets } = target.secrets;
  return {
    ...restored,
    serverId: target.serverId,
    engineImage: target.engineImage,
    containerName: target.containerName,
    startedAt: target.startedAt,
    completedSteps: target.completedSteps,
    secrets: {
      ...targetSecrets,
      ...(restored.secrets.DOMAIN_ADMIN_PASSWD_PLAIN
        ? { DOMAIN_ADMIN_PASSWD_PLAIN: restored.secrets.DOMAIN_ADMIN_PASSWD_PLAIN }
        : {}),
    },
    webmail: target.webmail,
    dnsRecords: null,
    dnsAcknowledged: false,
    ptrAcknowledged: false,
    additionalDomains: Object.fromEntries(
      Object.entries(restored.additionalDomains ?? {}).map(([domain, settings]) => [
        domain,
        { ...settings, acknowledgedAt: null },
      ]),
    ),
    logs: [],
    resumeStep: target.resumeStep,
    errorMessage: null,
    updatedAt: new Date().toISOString(),
  };
}
