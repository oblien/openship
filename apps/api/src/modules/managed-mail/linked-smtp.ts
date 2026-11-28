import { createHash } from "node:crypto";
import { AppError, OBLIEN_RELAY, shellQuote } from "@repo/core";
import type { linkedMailRequest } from "../mail/account-target";
import { sshManager } from "@repo/platform/engine/lib/ssh-manager";
import { decrypt } from "@repo/platform/engine/lib/encryption";
import { readState } from "@repo/platform/engine/modules/mail/mail-state";
import { configureOutboundRelay } from "@repo/platform/engine/modules/mail/admin/outbound-relay.service";
import {
  mailEngineCommand,
  requireMailEngine,
} from "@repo/platform/engine/modules/mail/mail-engine";

export function smtpInstallationId(
  org: string,
  serviceId: string,
  cloud: { apiUrl: string; organizationId: string },
) {
  return createHash("sha256")
    .update(JSON.stringify([org, serviceId, cloud.apiUrl, cloud.organizationId]))
    .digest("hex");
}

export async function configureLinkedSmtp(
  request: Awaited<ReturnType<typeof linkedMailRequest>>,
  org: string,
  serviceId: string,
  domainId: string,
  domain: string,
) {
  const installation = smtpInstallationId(org, serviceId, request.identity);
  return sshManager.withExecutor(serviceId, async (exec) => {
    const state = await readState(exec);
    if (!state) throw new AppError("Complete mail server setup first.", 409);
    const current = state.outboundRelay;
    if (current?.enabled && current.linkedInstallation !== installation)
      throw new AppError(
        "Disable the current SMTP relay in Sending before switching to OpenShip Cloud.",
        409,
      );
    // Test the route from Postfix's network, before issuing an SMTP secret or changing delivery.
    const { flavor } = await requireMailEngine(exec);
    const probe = [
      "import smtplib, ssl, sys",
      `with smtplib.SMTP("${OBLIEN_RELAY.hostTemplate}", ${OBLIEN_RELAY.defaultPort}, timeout=8) as server:`,
      "    server.ehlo()",
      "    server.starttls(context=ssl.create_default_context())",
      "    server.ehlo()",
      "    sys.exit(0 if server.has_extn('auth') else 1)",
    ].join("\n");
    try {
      await exec.exec(mailEngineCommand(flavor, "python3 -c " + shellQuote(probe)), {
        timeout: 20_000,
      });
    } catch {
      throw new AppError(
        "This mail server could not connect securely to the OpenShip SMTP relay. Retry later or use webmail sending through the Email API.",
        503,
      );
    }
    const key = await request<{ namespace: string; id: string; secret?: string }>(
      "/sending/domains/" + encodeURIComponent(domainId) + "/smtp-key",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          installation,
          installedId: current?.passwordEncrypted ? current.credentialId : undefined,
        }),
      },
    );
    const domains = current?.domains ?? [];
    let password = key.secret;
    if (!password) {
      if (
        !current?.passwordEncrypted ||
        current.username !== key.namespace ||
        key.id !== current.credentialId
      )
        throw new AppError("Cloud could not confirm this server’s SMTP credential.", 502);
      if (domains.includes(domain)) return { configured: true };
      password = decrypt(current.passwordEncrypted);
    }
    try {
      await configureOutboundRelay(exec, {
        provider: OBLIEN_RELAY.id,
        host: OBLIEN_RELAY.hostTemplate,
        port: OBLIEN_RELAY.defaultPort,
        scope: "selected",
        domains: [...new Set([...domains, domain])],
        addresses: current?.addresses,
        username: key.namespace,
        credentialId: key.id,
        linkedInstallation: installation,
        password,
      });
    } catch (error) {
      const saved = (await readState(exec))?.outboundRelay;
      if (saved?.credentialId !== key.id || !saved.domains?.includes(domain)) {
        if (key.secret && saved?.credentialId !== key.id)
          await request("/sending/keys/" + encodeURIComponent(key.id), { method: "DELETE" });
        throw error;
      }
    }
    return { configured: true };
  });
}
