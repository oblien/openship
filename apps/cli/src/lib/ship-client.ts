/** CLI composition only. Requests, pagination, uploads, and events belong to the SDK. */
import { OpenshipClient, ApiError } from "@repo/sdk/client";
import type { ScopedShip } from "@repo/sdk/native";
import { getActiveContext, getApiUrl, getToken } from "./config";
import { isNativeMode, nativeSession } from "./native-client";
import type { ProjectLink } from "./project-link";

export { ApiError } from "@repo/sdk/client";
export { isNativeMode, nativeSession, closeNativeClient } from "./native-client";
export type CliShipClient = Omit<ScopedShip, "organizationId">;

declare const __CLI_VERSION__: string;
export const cliUserAgent = "openship-cli/" + (typeof __CLI_VERSION__ === "string" ? __CLI_VERSION__ : "dev");

// Set once by the root preAction hook, never read from mutable server session
// state. The SDK checks fixed-scope support and authorization before requests.
let commandOrganization: string | undefined;
export function setCommandOrganization(id: string | undefined): void { commandOrganization = id; }
export function getCommandOrganization(): string | undefined { return commandOrganization; }

export function getRemoteClient(context?: string): OpenshipClient {
  if (isNativeMode()) throw new ApiError("This command requires an HTTP connection. Use a remote context for this operation.", 400, { code: "REMOTE_CONNECTION_REQUIRED" });
  return new OpenshipClient({
    baseUrl: getApiUrl(context),
    token: getToken(context, { deferred: true }) ?? undefined,
    organizationId: commandOrganization,
    userAgent: cliUserAgent,
  });
}

export function getShipClient(): CliShipClient {
  if (!isNativeMode()) return getRemoteClient();
  const session = nativeSession();
  if (!session) throw new Error("The native CLI connection is not available");
  return session.client;
}

export const hasShipCredentials = () => isNativeMode() ? !!nativeSession() : !!getToken(undefined, { deferred: true });

/** A directory link must never silently select a different installation or tenant. */
export function assertLinkedProjectConnection(link: ProjectLink | null): void {
  if (!link) return;
  const session = nativeSession();
  if (link.native) {
    if (!session || link.native.instanceId !== session.ship.instanceId || link.native.organizationId !== session.client.organizationId)
      throw new Error("This project is linked to a different native instance or organization. Select its --native-config or link it again with openship init --force.");
  } else if (isNativeMode() && link.context) {
    throw new Error("This project is linked to a remote context. Link it to this native instance with openship init --force, or pass --project explicitly.");
  } else if (!isNativeMode() && (
    (link.context && link.context !== getActiveContext()) ||
    link.organizationId !== commandOrganization ||
    (link.apiUrl && link.apiUrl !== getRemoteClient().http.apiUrl)
  )) {
    throw new Error(`This project is linked to a different connection${link.context ? ` (context "${link.context}")` : ""}. ${link.context === "local" ? "Use --local for the installation on this machine" : "Select that context with openship context use"}, link it again with openship init --force, or pass --project explicitly.`);
  }
}
