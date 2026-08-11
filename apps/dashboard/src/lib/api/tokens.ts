import { api } from "./client";
import { endpoints } from "./endpoints";
import type { PickerGrant } from "./permissions";

export interface AccessToken {
  id: string;
  name: string;
  tokenPrefix: string;
  readOnly: boolean;
  /** True when the token is limited to specific resources (its own grants). */
  scoped: boolean;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

/** Returned only from create — carries the one-time plaintext `token`. */
export interface CreatedAccessToken extends AccessToken {
  token: string;
}

export const tokensApi = {
  list: () => api.get<{ data: AccessToken[] }>(endpoints.tokens.list),
  create: (body: {
    name: string;
    readOnly?: boolean;
    expiresInDays?: number;
    /** Non-empty → a scoped token limited to exactly these resources. */
    grants?: PickerGrant[];
    /** Required when `grants` is empty/omitted: deliberately mint an UNSCOPED
     *  token with the caller's own access. The server refuses to infer this. */
    fullAccess?: boolean;
  }) => api.post<{ data: CreatedAccessToken }>(endpoints.tokens.list, body),
  revoke: (id: string) => api.delete<{ data: { revoked: boolean } }>(endpoints.tokens.item(id)),
  /** Record an OAuth MCP client's scope (org + read-only + resource grants) at consent. */
  mcpAuthorize: (body: {
    clientId: string;
    readOnly: boolean;
    grants: PickerGrant[];
    organizationId?: string;
    /** Required when `grants` is empty: the chosen template really does mean
     *  "no limits" (isUnscopedTemplate), rather than a scoped pick that came
     *  out empty. The server refuses to guess between the two. */
    fullAccess?: boolean;
    /** "edit" re-scopes an already-connected client from the settings MCP tab.
     *  Omit for the consent flow. */
    mode?: "consent" | "edit";
    /** Required to widen an edit to unscoped — the server refuses without it,
     *  because that takes effect on the agent's very next request. */
    confirmWiden?: boolean;
  }) =>
    api.post<{ data: { ok: boolean; scoped: boolean; readOnly: boolean } }>(
      endpoints.tokens.mcpAuthorize,
      body,
    ),

  /** The caller's connected MCP clients (OAuth bindings) for the settings list. */
  listMcpClients: () => api.get<{ data: McpClient[] }>(endpoints.tokens.mcpClients),

  /** One client WITH its grants — the prefill for the access editor. */
  getMcpClient: (clientId: string) =>
    api.get<{ data: McpClientDetail }>(endpoints.tokens.mcpClient(clientId)),

  /** Disconnect a client: revoke its tokens + drop its binding/consent. */
  disconnectMcpClient: (clientId: string) =>
    api.delete<{ data: { ok: boolean } }>(endpoints.tokens.mcpClient(clientId)),
};

/** A connected MCP client, as shown in the settings management list. */
export interface McpClient {
  clientId: string | null;
  name: string;
  organizationId: string | null;
  organizationName: string | null;
  readOnly: boolean;
  scoped: boolean;
  grantCount: number;
  authorizedAt: string;
  lastUsedAt: string | null;
}

/**
 * A client plus the grants it actually holds. Only the detail route returns these —
 * the list ships a count, since that is all its rows render.
 *
 * `scope` is present on a grant that carries a source-path restriction and MUST be
 * handed back on save: `mcp-authorize` replaces grants wholesale, so dropping it on
 * load silently strips the restriction.
 */
export interface McpClientDetail extends McpClient {
  grants: PickerGrant[];
}
