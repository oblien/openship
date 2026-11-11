import { AppError } from "@repo/core";
import { safeFetch } from "../../lib/safe-fetch";

export type MigrationProvider = "railway" | "vercel";
export interface ProviderAccess {
  provider: MigrationProvider;
  publicFields: Record<string, string>;
  secrets: Record<string, string>;
}

/** Fixed provider origins, bounded responses, no redirects, and no upstream
 * response bodies in errors: provider errors can contain credentials or env. */
export async function providerJson<T>(
  url: URL,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<T> {
  if (!["https://api.vercel.com", "https://backboard.railway.com"].includes(url.origin))
    throw new AppError("Unsupported connection endpoint", 400, "CONNECTION_ENDPOINT_INVALID");
  let response;
  try {
    response = await safeFetch(url.href, {
      ...options,
      timeoutMs: 30_000,
      maxBodyBytes: 8 * 1024 * 1024,
    });
  } catch {
    throw new AppError(
      "The provider could not be reached. Retry the connection.",
      502,
      "CONNECTION_UNAVAILABLE",
    );
  }
  if (!response.ok) {
    const auth = response.status === 401 || response.status === 403;
    throw new AppError(
      auth
        ? "The provider refused access. Reconnect with access to the selected workspace and projects."
        : response.status === 429
          ? "The provider rate limit was reached. Wait and retry."
          : "The provider request failed. Retry discovery before importing.",
      auth ? 403 : 502,
      auth ? "CONNECTION_ACCESS_DENIED" : "CONNECTION_REQUEST_FAILED",
    );
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new AppError(
      "The provider returned an invalid response",
      502,
      "CONNECTION_RESPONSE_INVALID",
    );
  }
}

export async function railwayQuery<T>(
  access: ProviderAccess,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const token = access.secrets.apiToken;
  if (!token)
    throw new AppError("Reconnect Railway before importing", 409, "CONNECTION_RECONNECT_REQUIRED");
  const result = await providerJson<{ data?: T; errors?: unknown[] }>(
    new URL("https://backboard.railway.com/graphql/v2"),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(access.publicFields.tokenType === "project"
          ? { "Project-Access-Token": token }
          : { Authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify({ query, variables }),
    },
  );
  if (result.errors?.length || !result.data)
    throw new AppError(
      "Railway could not read the selected resources. Check the connection's scope and retry.",
      502,
      "RAILWAY_QUERY_FAILED",
    );
  return result.data;
}

export function vercelRequest<T>(
  access: ProviderAccess,
  path: string,
  query: Record<string, string> = {},
): Promise<T> {
  if (!path.startsWith("/") || path.startsWith("//")) throw new Error("Expected a Vercel API path");
  if (!access.secrets.apiToken)
    throw new AppError("Reconnect Vercel before importing", 409, "CONNECTION_RECONNECT_REQUIRED");
  const url = new URL(path, "https://api.vercel.com");
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  if (access.publicFields.teamId) url.searchParams.set("teamId", access.publicFields.teamId);
  return providerJson<T>(url, { headers: { Authorization: `Bearer ${access.secrets.apiToken}` } });
}

export async function verifyProviderAccess(access: ProviderAccess): Promise<void> {
  if (access.provider === "vercel") {
    await vercelRequest(access, "/v9/projects", { limit: "1" });
  } else if (access.publicFields.tokenType === "project") {
    await railwayQuery(access, "query { projectToken { project { id } environment { id } } }");
  } else if (access.publicFields.tokenType === "workspace") {
    if (!access.publicFields.workspaceId)
      throw new AppError(
        "A workspace ID is required for this Railway token",
        400,
        "CONNECTION_SCOPE_REQUIRED",
      );
    await railwayQuery(
      access,
      "query($id: String!) { projects(workspaceId: $id, first: 1) { edges { node { id } } } }",
      { id: access.publicFields.workspaceId },
    );
  } else {
    await railwayQuery(access, "query { me { id } }");
  }
}
