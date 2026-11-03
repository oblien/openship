import { AsyncLocalStorage } from "node:async_hooks";
import { resolveAuthBaseUrl } from "./public-url";

// The API's existing public-origin resolver gives configured URLs precedence
// over proxy headers. Scope the OAuth issuer to that request so concurrent
// proxy/direct requests cannot mutate one another's signing configuration.
const issuers = new AsyncLocalStorage<string>();
export const mcpIssuer = () => issuers.getStore() ?? resolveAuthBaseUrl();
export const withMcpIssuer = <T>(origin: string, operation: () => T): T =>
  issuers.run(origin, operation);
