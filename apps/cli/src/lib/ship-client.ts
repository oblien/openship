/** CLI composition only. Requests, pagination, uploads, and events belong to the SDK. */
import { OpenshipClient, ApiError } from "@repo/sdk/client";
import type { ScopedShip } from "@repo/sdk/native";
import { getApiUrl, getToken } from "./config";
import { isNativeMode, nativeSession } from "./native-client";
import type { ProjectLink } from "./project-link";

export { ApiError } from "@repo/sdk/client";
export { isNativeMode, nativeSession, closeNativeClient } from "./native-client";
export type CliShipClient = Omit<ScopedShip, "organizationId">;

declare const __CLI_VERSION__: string;
export const cliUserAgent = "openship-cli/" + (typeof __CLI_VERSION__ === "string" ? __CLI_VERSION__ : "dev");

export function getRemoteClient(context?: string): OpenshipClient {
  if (isNativeMode()) throw new ApiError("This command requires an HTTP connection. Use a remote context for this operation.", 400, { code: "REMOTE_CONNECTION_REQUIRED" });
  return new OpenshipClient({
    baseUrl: getApiUrl(context),
    token: () => getToken(context) ?? undefined,
    userAgent: cliUserAgent,
  });
}

export function getShipClient(): CliShipClient {
  if (!isNativeMode()) return getRemoteClient();
  const session = nativeSession();
  if (!session) throw new Error("The native CLI connection is not available");
  return session.client;
}

export const hasShipCredentials = () => isNativeMode() ? !!nativeSession() : !!getToken();

/** A project linked to a native instance must never fall back to a remote context. */
export function assertLinkedProjectConnection(link: ProjectLink | null): void {
  if (!link) return;
  const session = nativeSession();
  if (link.native) {
    if (!session || link.native.instanceId !== session.ship.instanceId || link.native.organizationId !== session.client.organizationId)
      throw new Error("This project is linked to a different native instance or organization. Select its --native-config or link it again with openship init --force.");
  } else if (isNativeMode() && link.context) {
    throw new Error("This project is linked to a remote context. Link it to this native instance with openship init --force, or pass --project explicitly.");
  }
}
