import { TtlCache } from "../../../state/cache";
import { MAIL_SERVICE_HEADER, MAIL_TENANT_TOKEN_PREFIX } from "@repo/contracts/managed-mail";
import { createHash } from "node:crypto";
import { diagnostics } from "@repo/core/diagnostics";
import { AppError } from "@repo/core";
import type { MailSetupStatusSchema } from "@repo/contracts";
import type { Static } from "@sinclair/typebox";
import type { MailEngine } from "./service";

export type MailTarget = MailEngine &
  ({ tenant?: undefined; serviceId?: undefined } | { tenant: string; serviceId: string });
const credentials = new TtlCache<string>();

export async function sharedMailTarget(
  engine: MailEngine,
  tenant: string,
  serviceId: string,
): Promise<MailTarget> {
  const key = createHash("sha256")
    .update(JSON.stringify([engine.origin, engine.serverId, engine.token, tenant, serviceId]))
    .digest("hex");
  let token = credentials.get(key);
  if (!token) {
    const access = await engineRequest<{ token: string }>(
      engine,
      "/admin/" + encodeURIComponent(engine.serverId) + "/tenant-access",
      "POST",
      { namespace: tenant, serviceId, imapHost: engine.hostname },
    );
    if (typeof access.token !== "string" || !access.token.startsWith(MAIL_TENANT_TOKEN_PREFIX))
      throw new AppError("The worker did not issue shared mail access.", 502);
    token = access.token;
    credentials.set(key, token, 300);
  }
  return { ...engine, token, tenant, serviceId };
}

export async function engineResponse(
  engine: MailTarget,
  path: string,
  method = "GET",
  body?: unknown,
  timeout = 45_000,
) {
  const prefix = engine.tenant
    ? "/api/mail/tenants/" + encodeURIComponent(engine.tenant)
    : "/api/mail";
  const result = await fetch(new URL(prefix + path, engine.origin), {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(timeout),
    headers: {
      authorization: "Bearer " + engine.token,
      "content-type": "application/json",
      ...(engine.serviceId && { [MAIL_SERVICE_HEADER]: engine.serviceId }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(() => {
    throw new AppError("Cannot reach your mail engine.", 503, "MAIL_ENGINE_UNAVAILABLE");
  });
  if (!result.ok) {
    if (result.status === 404)
      throw new AppError("Mail resource not found.", 404, "MAIL_NOT_FOUND");
    if (result.status === 409)
      throw new AppError("The mail resource conflicts with an existing account or alias.", 409);
    if (result.status === 400)
      throw new AppError("The mail engine rejected the account settings.", 400);
    throw new AppError("Your mail engine could not complete this operation.", 502);
  }
  return result;
}
export async function engineRequest<T>(
  engine: MailTarget,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await engineResponse(engine, path, method, body);
  return response.json() as Promise<T>;
}

export function workerStatus(engine: MailEngine) {
  return engineRequest<Static<typeof MailSetupStatusSchema>>(
    engine,
    "/status?serverId=" + encodeURIComponent(engine.serverId),
  );
}

export async function bindReadyMailEngine(engine: MailEngine, namespace: string) {
  const slot = engine.hostname;
  const path = "/admin/" + encodeURIComponent(engine.serverId);
  const worker = await workerStatus(engine).catch(() => {
    diagnostics.warn("managed-mail", "Could not reach an unassigned mail worker.", { slot });
    return null;
  });
  if (
    !worker ||
    worker.active ||
    worker.observationError ||
    worker.serverId !== engine.serverId ||
    !worker.webmail?.projectId ||
    worker.webmail.routingUnknown ||
    !worker.finishedAt ||
    !worker.engine?.running ||
    worker.engine.flavor !== "container" ||
    !worker.webmail?.installed ||
    worker.domain !== engine.hostname.replace(/^mail\./, "") ||
    !URL.canParse(worker.webmail.url) ||
    new URL(worker.webmail.url).origin !== new URL(engine.webmailUrl).origin
  )
    return false;
  if (!engine.shared) {
    const { domains } = await engineRequest<{ domains: { domain: string }[] }>(
      engine,
      path + "/domains",
    );
    if (domains.length !== 1 || "mail." + domains[0].domain !== engine.hostname) {
      diagnostics.warn("managed-mail", "Skipping an occupied mail installation.", { slot });
      return false;
    }
  }
  const dedicated = engine.placement === "dedicated" && worker.webmail.serverId === engine.serverId && !worker.webmail.workspaceId;
  const hosted = await engineRequest<{ bound: boolean; apiRelay?: boolean }>(engine, path + "/webmail/hosting", "PUT", {
    ...(engine.shared ? { shared: true } : { namespace, ...(dedicated && { dedicated: true }) }),
    imapHost: engine.hostname,
  });
  return hosted.bound === true && hosted.apiRelay === true;
}
