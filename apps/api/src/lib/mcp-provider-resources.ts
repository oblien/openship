import { APIError } from "better-auth/api";
import { auth } from "@repo/platform/engine/lib/auth";
import { resolveAuthBaseUrl } from "@repo/platform/engine/lib/public-url";
import { allowedMcpResources } from "./mcp-resource";

// Better Auth seeds the startup configuration. Only a subsequent trusted
// configuration change needs reconciliation, after a user has authenticated.
const initialized = new Set([new URL(resolveAuthBaseUrl()).origin]);
const pending = new Map<string, Promise<void>>();

export async function synchronizeMcpProviderResources(headers: Headers): Promise<void> {
  const origin = new URL(resolveAuthBaseUrl()).origin;
  if (initialized.has(origin)) return;
  let operation = pending.get(origin);
  if (!operation) {
    operation = registerConfiguredResources(origin, headers);
    pending.set(origin, operation);
  }
  try {
    await operation;
    initialized.add(origin);
  } finally {
    if (pending.get(origin) === operation) pending.delete(origin);
  }
}

async function registerConfiguredResources(origin: string, headers: Headers): Promise<void> {
  for (const identifier of allowedMcpResources(origin)) {
    const read = () => auth.api.adminGetOAuthResource({ headers, params: { identifier } });
    try {
      await read();
      continue;
    } catch (error) {
      // diagnostics-ignore: A missing configured resource is created below; other failures propagate.
      if (!(error instanceof APIError) || error.status !== "NOT_FOUND") throw error;
    }
    try {
      await auth.api.adminCreateOAuthResource({
        headers,
        body: { identifier, name: "Openship MCP" },
      });
    } catch (error) {
      // Another API replica may have registered it concurrently. Confirm the
      // row exists instead of matching a database-specific duplicate error.
      try {
        await read();
      } catch {
        // diagnostics-ignore: Preserve the original registration failure for the API error boundary.
        throw error;
      }
    }
  }
}
