import { AsyncLocalStorage } from "node:async_hooks";
import { resolveAuthBaseUrl } from "./public-url";

// Issuers come only from configuration (including the verified self-app domain
// and the desktop's advertised port), never request or forwarded headers.
// Snapshot that configuration for the duration of each provider request.
const issuers = new AsyncLocalStorage<string>();
export const mcpIssuer = () => issuers.getStore() ?? new URL(resolveAuthBaseUrl()).origin;
export const withMcpIssuer = <T>(operation: () => T): T =>
  issuers.run(new URL(resolveAuthBaseUrl()).origin, operation);
