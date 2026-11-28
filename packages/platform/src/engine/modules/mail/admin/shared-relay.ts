import { managedMailNamespacePattern } from "@repo/contracts/managed-mail";
import { AppError, OBLIEN_RELAY } from "@repo/core";
import { createProvisionLock } from "../../../lib/provision-lock";
import { sshManager } from "../../../lib/ssh-manager";
import { readState } from "../mail-state";
import { validateMailDomain } from "../mail-domain";
import {
  mailConfigFile,
  mailEngineCommand,
  resolveMailMutationAccess,
  requireMailEngine,
  writeMailConfigFile,
} from "../mail-engine";

type SenderKey = { domain: string; namespace: string; key: string };

/** Only authenticated submission can use this transport. Inbound MX, bounces
 * and automatic forwards have no authenticated payer and cannot borrow the
 * envelope sender's credential. Local virtual delivery remains on Dovecot. */
export async function configureSharedRelay(serverId: string, sender?: SenderKey, exclusiveNamespace?: string) {
  if (sender) {
    validateMailDomain(sender.domain);
    if (
      !managedMailNamespacePattern.test(sender.namespace) ||
      !/^[A-Za-z0-9._~-]+$/.test(sender.key)
    )
      throw new AppError("Invalid relay credential.", 400);
  }
  return createProvisionLock("mail:shared-relay:" + serverId).run(() =>
    sshManager.withExecutor(serverId, async (exec) => {
      const { flavor } = await requireMailEngine(exec);
      if (flavor !== "container")
        throw new AppError("Shared mail requires a container mail engine.", 409);
      if (exclusiveNamespace) {
        const prior = (await readState(exec))?.outboundRelay;
        if (prior?.enabled && prior.provider === OBLIEN_RELAY.id && prior.username === exclusiveNamespace) return;
      }
      const path = mailConfigFile(flavor, "saslPasswd");
      const file = path.write + ".openship-tenants";
      const engineFile = path.engine + ".openship-tenants";
      const { hostFiles, engineExec } = await resolveMailMutationAccess(exec, flavor, [
        { path: file },
      ]);
      const run = (cmd: string) => engineExec.exec(mailEngineCommand(flavor, cmd));
      const exists = await hostFiles.exists(file);
      const previous = exists ? await hostFiles.readFile(file) : "";
      if (sender || !exists) {
        await writeMailConfigFile(hostFiles, file, sharedRelayMap(previous, sender), {
          mode: 0o600,
        });
      }
      await applySharedSubmission(run, engineFile, !!sender || !!previous.trim());
    }),
  );
}

export function sharedRelayMap(previous: string, sender?: SenderKey) {
  if (!sender) return previous || "\n";
  const prefix = "/@" + sender.domain.replaceAll(".", "\\.") + "$/ ";
  const rows = previous.split("\n").filter((line) => line && !line.startsWith(prefix));
  rows.push(prefix + sender.namespace + ":" + sender.key);
  return rows.join("\n") + "\n";
}

// Apply to the authenticated submission listeners. MX and local delivery use their existing transports.
export async function applySharedSubmission(
  run: (command: string) => Promise<unknown>,
  engineFile: string,
  legacySmtp = true,
) {
  const relay = `[${OBLIEN_RELAY.hostTemplate}]:${OBLIEN_RELAY.defaultPort}`;
  await run("postconf -M 'openship-submit/unix=openship-submit unix - - n - - smtp'");
  await run(
    `postconf -P 'openship-submit/unix/smtp_sender_dependent_authentication=yes' 'openship-submit/unix/smtp_sasl_auth_enable=yes' 'openship-submit/unix/smtp_sasl_password_maps=pcre:${engineFile}' 'openship-submit/unix/smtp_sasl_security_options=noanonymous' 'openship-submit/unix/smtp_tls_security_level=secure'`,
  );
  // Postfix treats the literal "error" transport as an SMTP-time rejection,
  // before the submission listener can select its authenticated delivery transport.
  await run("postconf -M 'openship-deny/unix=openship-deny unix - - n - - error'");
  await run(
    "postconf -e 'default_transport=openship-deny:5.7.1 Outbound delivery requires authenticated submission' 'relay_transport=openship-deny:5.7.1 Unattributed delivery' 'relayhost=' 'openship_unconfigured_submission=openship-deny:5.7.1 Enable managed sending for this domain'",
  );
  for (const service of ["submission", "465"]) {
    const outbound = legacySmtp ? "openship-submit:" + relay : "$openship_unconfigured_submission";
    await run(
      `postconf -P '${service}/inet/smtpd_relay_restrictions=permit_sasl_authenticated,reject' '${service}/inet/smtpd_sender_restrictions=reject_authenticated_sender_login_mismatch' '${service}/inet/content_filter=${outbound}'`,
    );
  }
  await run("postfix check");
  await run("postfix reload");
}
