import { diagnostics as errorDiagnostics } from "@repo/core/diagnostics";
import { AppError } from "@repo/core";
import { cloudRuntimeTarget } from "../../config/env";
import { readCloudJson } from "./transport";
import { parseAllowedCloudOrigin } from "./origin";
import type { CloudAccount } from "./types";

/** The pre-connection exchange has no stored credential yet. Bound its whole
 * response, including the body, and never redirect a login code or bearer.
 * `baseUrl` defaults to the official cloud API. A self-hosted desktop passes
 * the instance origin it just verified. */
export async function fetchCloudConnection(
  path: string,
  init?: RequestInit,
  baseUrl?: string,
): Promise<Response> {
  const origin = parseAllowedCloudOrigin(baseUrl ?? cloudRuntimeTarget.api);
  if (!origin) {
    throw new AppError("Cloud API origin was rejected.", 400, "CLOUD_ORIGIN_REJECTED");
  }
  const timeout = AbortSignal.timeout(15_000);
  let response: Response;
  try {
    response = await fetch(`${origin}${path}`, {
      ...init,
      redirect: "error",
      signal: init?.signal ? AbortSignal.any([timeout, init.signal]) : timeout,
    });
  } catch (error) {
    const cause =
      error instanceof Error ? (error.cause as { code?: unknown } | undefined)?.code : undefined;
    if (typeof cause === "string" && /^[A-Z0-9_]+$/.test(cause))
      errorDiagnostics.warn("platform/engine/lib/cloud/connection", `[cloud-connect] ${path} failed: ${cause}`, error);
    throw new AppError(
      timeout.aborted
        ? "Openship Cloud did not respond in time. Start a new connection attempt."
        : "Could not reach Openship Cloud. Check your connection and start a new connection attempt.",
      503,
      timeout.aborted ? "CLOUD_CONNECTION_TIMEOUT" : "CLOUD_CONNECTION_UNAVAILABLE",
    );
  }
  if (response.status >= 500 || response.status === 429)
    throw new AppError(
      "Openship Cloud is temporarily unavailable. Start a new connection attempt shortly.",
      503,
      "CLOUD_CONNECTION_UNAVAILABLE",
    );
  return response;
}

type AccountRequest = (path: string) => Promise<Response | null>;
const nonempty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

/** v0.8.0's /account contains only a profile. Resolve its missing IDs from the
 * authenticated session and authorized workspace endpoints, never from email,
 * local IDs, or a browser's selected workspace. The same resolver serves both
 * connection setup and live validation, whose requester pins organizationId. */
export async function readVerifiedCloudAccount(
  response: Response,
  request: AccountRequest,
): Promise<CloudAccount | null> {
  const account = (await readCloudJson<{ user?: Partial<CloudAccount> }>(response))?.user;
  if (!account || typeof account !== "object" || Array.isArray(account)) return null;
  if (nonempty(account.id) && nonempty(account.organizationId)) return account as CloudAccount;
  // Only the known profile-only response may use compatibility discovery.
  // Partial or malformed identity fields must not be replaced with new claims.
  if (account.id !== undefined || account.organizationId !== undefined || !nonempty(account.email))
    return null;

  const [sessionResponse, organizationResponse] = await Promise.all([
    request("/api/auth/get-session"),
    request("/api/permissions/org-meta"),
  ]);
  if (!sessionResponse?.ok || !organizationResponse?.ok) return null;
  const [identity, organization] = await Promise.all([
    readCloudJson<{
      user?: { id?: string; email?: string };
      session?: { userId?: string; expiresAt?: string };
    }>(sessionResponse),
    readCloudJson<{ data?: { organizationId?: string } }>(organizationResponse),
  ]);
  const user = identity?.user;
  const session = identity?.session;
  if (
    !nonempty(user?.id) ||
    session?.userId !== user.id ||
    user.email !== account.email ||
    !nonempty(session?.expiresAt) ||
    !(Date.parse(session.expiresAt) > Date.now()) ||
    !nonempty(organization?.data?.organizationId)
  )
    return null;
  return {
    ...account,
    id: user.id,
    organizationId: organization.data.organizationId,
  } as CloudAccount;
}
