import { createAuthMiddleware } from "better-auth/api";
import { mcpIssuer } from "./mcp-issuer";
import { MCP_RESOURCE_PATH } from "./mcp-resources";

/** Application policy around the provider's own parsing, validation and signing. */
export const mcpOAuthPolicy = createAuthMiddleware(async (ctx) => {
  if (ctx.path === "/oauth2/register") {
    const body = ctx.body;
    // Older native MCP clients omit application_type. Explicit web clients
    // still use the provider's stricter redirect validation.
    if (
      body?.application_type === undefined &&
      Array.isArray(body?.redirect_uris) &&
      body.redirect_uris.length &&
      body.redirect_uris.every((uri: unknown) => {
        if (typeof uri !== "string") return false;
        try {
          const callback = new URL(uri);
          return (
            callback.protocol === "http:" &&
            ["localhost", "127.0.0.1", "[::1]"].includes(callback.hostname)
          );
        } catch {
          return false;
        }
      })
    ) {
      return { context: { body: { ...body, application_type: "native" } } };
    }
    return;
  }
  if (
    ctx.path !== "/oauth2/authorize" ||
    !ctx.request ||
    !new URL(ctx.request.url).pathname.endsWith("/oauth2/authorize")
  )
    return;

  // Do not rewrite the provider's signed query when it resumes after login/MFA.
  // For an initial request, preserve GET queries and POST forms, including PKCE.
  const key = ctx.method === "POST" ? "body" : "query";
  const parameters = ctx[key] ?? {};
  let prompt = parameters.prompt;
  if (prompt === undefined) prompt = "consent";
  else if (typeof prompt === "string" && prompt.trim()) {
    const prompts = prompt.split(/\s+/);
    // Keep interactive permission review, but let the provider own silent
    // requests and validation (including the invalid "none consent" pair).
    // Normalizing empty/invalid input here would hide it from that validation.
    if (!prompts.includes("none") && !prompts.includes("consent")) prompt += " consent";
  }
  return {
    context: {
      [key]: {
        ...parameters,
        prompt,
        resource: parameters.resource ?? `${mcpIssuer()}${MCP_RESOURCE_PATH}`,
      },
    },
  };
});
