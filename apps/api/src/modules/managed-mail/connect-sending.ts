import type { Context } from "hono";
import { linkedMailRequest } from "../mail/account-target";
import { configureLinkedSmtp } from "./linked-smtp";
import { isServerInOrg } from "@repo/platform/engine/lib/resource-access";
import { mailApiRelay } from "@repo/platform/engine/modules/mail/admin/api-relay";
import { sendingNamespace } from "@repo/platform/engine/modules/managed-mail/billing";
import { getRequestContext } from "../../lib/request-context";
import { getDomain } from "@repo/platform/engine/modules/mail/admin/domains.service";
import { linkedWebmailSending } from "../mail/webmail/sending-settings";
import { AppError } from "@repo/core";
import { createProvisionLock } from "@repo/platform/engine/lib/provision-lock";

export async function connectLinkedSending(
  c: Context,
  serviceId: string,
  domainId: string,
  transport: "webmail" | "smtp" | "api-relay" = "webmail",
) {
  return createProvisionLock("managed-mail:delivery:" + serviceId).run(async () => {
    const ctx = getRequestContext(c);
    if (!(await isServerInOrg(ctx, serviceId))) throw new AppError("Mail server not found.", 404);
    const request = await linkedMailRequest(ctx);
    const remote = <T>(suffix: string, method = "GET") =>
      request<T>("/sending/" + suffix, { method });
    const domain = await remote<{ domain: string; state: string; disabled?: boolean }>(
      "domains/" + domainId,
    );
    if (
      domain.disabled ||
      domain.state !== "ready" ||
      !(await getDomain(serviceId, domain.domain))?.active
    )
      throw new AppError("Verify this server’s sender domain first.", 409);
    if (transport === "smtp") {
      return configureLinkedSmtp(request, ctx.organizationId, serviceId, domainId, domain.domain);
    }
    const apiOrigin = new URL(request.identity.apiUrl).origin;
    const authority = { apiOrigin, namespace: sendingNamespace(request.identity.organizationId) };
    const read = async () => {
      if (transport === "api-relay") {
        const status = await mailApiRelay(serviceId, domain.domain, authority);
        return status && { ...status, apiOrigin };
      }
      const state = await linkedWebmailSending(c, serviceId, domain.domain);
      return "sending" in state ? state.sending : null;
    };
    const current = await read();
    const { data: keys } = await remote<{ data: Array<{ id: string; domainId: string | null }> }>(
      "keys",
    );
    if (
      current?.apiOrigin === apiOrigin &&
      keys.some((key) => key.id === current.keyId && key.domainId === domainId)
    )
      return { configured: true };
    const key = await remote<{ id: string; key: string }>("domains/" + domainId + "/key", "POST");
    try {
      const credential = { keyId: key.id, key: key.key };
      if (transport === "api-relay")
        await mailApiRelay(serviceId, domain.domain, authority, credential);
      else await linkedWebmailSending(c, serviceId, domain.domain, { apiOrigin, ...credential });
    } catch (error) {
      // A timeout may follow a committed install. Read back before revoking.
      if ((await read())?.keyId !== key.id) {
        await remote("keys/" + encodeURIComponent(key.id), "DELETE");
        throw error;
      }
    }
    return { configured: true };
  });
}

export async function linkedApiRelayState(
  c: Context,
  serverId: string,
  domainId: string,
  remove: boolean,
) {
  const ctx = getRequestContext(c);
  if (!(await isServerInOrg(ctx, serverId))) throw new AppError("Mail server not found.", 404);
  const request = await linkedMailRequest(ctx);
  const { domain } = await request<{ domain: string }>(
    "/sending/domains/" + encodeURIComponent(domainId),
  );
  if (!(await getDomain(serverId, domain))) return { keyId: null };
  const authority = {
    apiOrigin: new URL(request.identity.apiUrl).origin,
    namespace: sendingNamespace(request.identity.organizationId),
  };
  return createProvisionLock("managed-mail:delivery:" + serverId).run(async () => {
    const current = await mailApiRelay(serverId, domain, authority);
    if (!remove || !current) return { keyId: current?.keyId ?? null };
    // Revoke before removing the local reference, so a failed disconnect can be retried.
    try {
      await request("/sending/keys/" + encodeURIComponent(current.keyId), { method: "DELETE" });
    } catch (error) {
      if (!(error instanceof AppError && error.statusCode === 404)) throw error;
    }
    await mailApiRelay(serverId, domain, authority, "remove");
    return { keyId: null };
  });
}
