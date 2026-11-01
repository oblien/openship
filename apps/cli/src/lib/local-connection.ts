import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { HttpClient } from "@repo/sdk/client";
import { internalFetch } from "./loopback-api";
import { internalTokenSources } from "./internal-token";
import { readInstanceUrl, storedApiPort, storedDashboardPort } from "./ports";

/** Discover only the installed service's ports, never a caller's remote URL. */
export function localConnectionEndpoints(): { apiUrl: string; dashboardUrl: string } {
  const port = storedApiPort();
  const dashboard = storedDashboardPort();
  for (const value of [port, dashboard]) {
    if (!Number.isInteger(value) || value < 1 || value > 65535)
      throw new Error("Invalid stored Openship port. Check this installation's ports.json.");
  }
  return {
    apiUrl: `http://127.0.0.1:${port}`,
    dashboardUrl: readInstanceUrl() ?? `http://localhost:${dashboard}`,
  };
}

/**
 * Setup and ordinary commands share the same on-disk operator credential.
 * Exchange it only at the pinned loopback endpoint. The resulting normal
 * session stays in memory and the SDK uses its usual bearer transport.
 */
export async function openLocalCliSession(apiUrl: string, required: boolean) {
  const sources = internalTokenSources();
  if (!required && sources.tokens.length === 0 && sources.problems.length === 0) return null;
  const url = new URL(apiUrl);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("Local administrator access requires this installation's loopback API.");
  const call = await internalFetch(url.port, "/api/system/cli-session", {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
  });
  if (call.kind !== "response")
    throw new Error(`Could not authenticate with the local installation: ${call.detail}`);
  if (call.res.status === 404) {
    throw new Error(
      "This local server does not support automatic CLI authentication yet. Update the server, or use openship login with a Personal Access Token.",
    );
  }
  if (!call.res.ok) {
    // Never echo the response body of a credential exchange.
    throw new Error(
      `Local administrator authentication failed (HTTP ${call.res.status}). Check the installation's operator credential and finish its admin setup, or use openship login.`,
    );
  }
  const body = (await call.res.json().catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "cli/lib/local-connection"); return null; })) as {
    token?: unknown;
    expiresAt?: unknown;
  } | null;
  if (
    typeof body?.token !== "string" ||
    !body.token.trim() ||
    /\s/.test(body.token) ||
    typeof body.expiresAt !== "string" ||
    !(Date.parse(body.expiresAt) > Date.now())
  )
    throw new Error(
      "The local server returned an invalid CLI session. Update the server and try again.",
    );
  const token = body.token;
  const http = new HttpClient({ baseUrl: apiUrl, token, timeoutMs: 3_000 });
  return {
    token,
    // Existing Better Auth sign-out invalidates only this command's session.
    // An unavailable/stopped server is covered by the session's expiry.
    close: async () => {
      await http.request("/auth/sign-out", { method: "POST", body: "{}" }).catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "cli/lib/local-connection"); return undefined; });
    },
  };
}
