import { createHash } from "node:crypto";
import { AppError, cloudRuntimeTarget } from "@repo/core";
import { repos } from "@repo/db";
import type { ExecutionContext } from "../../../context";
import { getOblienClient } from "../../lib/oblien-client";
import { createProvisionLock } from "../../lib/provision-lock";
import { createMailSendToken } from "../tokens/token.service";
import { sendingNamespace } from "./billing";
import { engineRequest, type MailTarget } from "./engine-client";
import { activateSending, listSendingKeys } from "./sending";

/** Install credentials wholly server-to-server. Query each side before
 * issuing a key so repeating verification resumes a partial handover. */
export async function connectHostedSending(
  ctx: ExecutionContext,
  serviceId: string,
  domainId: string,
  engine: MailTarget,
  action: "status" | "connect",
) {
  return createProvisionLock("managed-mail:delivery:" + serviceId).run(async () => {
    const org = ctx.organizationId;
    const namespace = action === "connect" ? await activateSending(org) : sendingNamespace(org);
    if (engine.tenant && engine.tenant !== namespace)
      throw new AppError("Mail service not found.", 404);
    const mail = getOblienClient().mail;
    const domain = await mail.domains.get(namespace, domainId);
    if (domain.id !== domainId || domain.state !== "ready")
      throw new AppError("Verify the sender domain first.", 409);
    const admin = "/admin/" + encodeURIComponent(engine.serverId);
    // A verified sender can be API-only until its mailbox domain is created.
    const local = await engineRequest<{ domain: { domain: string; active: boolean } }>(
      engine,
      admin + "/domains/" + encodeURIComponent(domain.domain),
    ).catch((error) => {
      if (action === "status" && error instanceof AppError && error.statusCode === 404) return null;
      throw error;
    });
    if (!local) return { configured: false };
    if (local.domain.domain !== domain.domain || !local.domain.active)
      throw new AppError("Enable this mailbox domain on the server first.", 409);
    const path = admin + "/webmail/sending/" + encodeURIComponent(domain.domain);
    const origin = new URL(cloudRuntimeTarget.api).origin;
    const read = () =>
      engineRequest<{
        apiRelay?: boolean;
        relayOrigin?: string;
        sending: {
          keyId: string;
          namespace?: string;
          apiOrigin?: string;
          relayKeyId?: string;
        } | null;
      }>(engine, path).then((result) => {
        if (!result.apiRelay)
          throw new AppError("Update the OpenShip Mail worker to enable the API relay.", 409);
        if (result.relayOrigin !== origin)
          throw new AppError("This mail server is linked to a different OpenShip Cloud API.", 409);
        return result.sending;
      });
    const current = await read();
    const active = await repos.personalAccessToken.listMailSendKeys(org);
    const installed = (s: Awaited<ReturnType<typeof read>>, keyId: string) =>
      s?.apiOrigin === origin &&
      s.namespace === namespace &&
      s.keyId === keyId &&
      s.relayKeyId === keyId;
    if (
      current &&
      installed(current, current.keyId) &&
      active.some((key) => key.id === current.keyId && key.domainId === domain.id)
    )
      return { configured: true };
    if (action === "status") return { configured: false };
    const retirePrevious = async (stillInUse?: string) => {
      const previous = new Set([current?.keyId, current?.relayKeyId]);
      for (const old of active) {
        if (old.id !== stillInUse && old.domainId === domain.id && previous.has(old.id))
          await repos.personalAccessToken.revokeMailSendKeys(org, { id: old.id });
      }
    };
    const key = await createMailSendToken(ctx, domain.id, domain.domain);
    try {
      // Workers that predate PAT relay support reject the explicit API origin
      // before they can install this credential as a provider key.
      await engineRequest(engine, path, "PUT", { namespace, apiOrigin: origin, keyId: key.id, key: key.token });
      if (!installed(await read(), key.id))
        throw new AppError(
          "Update the OpenShip Mail worker and webmail to enable the API relay.",
          409,
        );
    } catch (error) {
      const observed = await read();
      if (!installed(observed, key.id)) {
        // Webmail can already be using the key while Postfix still has its old
        // route. Preserve a confirmed installation until the next successful retry.
        if (
          observed?.apiOrigin !== origin ||
          observed.namespace !== namespace ||
          observed.keyId !== key.id
        )
          await repos.personalAccessToken.revokeMailSendKeys(org, { id: key.id });
        else await retirePrevious(observed.relayKeyId);
        throw error;
      }
    }
    await retirePrevious();
    if (current?.namespace === namespace && !current.apiOrigin) {
      const legacyName =
        "Hosted webmail · " +
        createHash("sha256")
          .update(JSON.stringify([serviceId, domain.id]))
          .digest("hex")
          .slice(0, 32);
      const legacy = (await listSendingKeys(namespace)).data.find(
        (item) =>
          item.id === current.keyId && item.name === legacyName && item.domainId === domain.id,
      );
      if (legacy) await mail.keys.revoke(namespace, legacy.id);
    }
    return { configured: true };
  });
}
