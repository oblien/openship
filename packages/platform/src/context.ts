export type ContextRole = "owner" | "admin" | "member" | "restricted";
export type SessionKind = "cookie" | "bearer" | "zero-auth" | "native";
export type PrincipalKind = "pat" | "oauth";

export interface ContextUser {
  readonly id: string;
  readonly email: string;
  readonly name: string | null;
}

export interface CredentialRestrictions {
  readonly organizationId: string | null;
  readonly readOnly: boolean;
  /** Unix milliseconds; omitted for identities whose adapter handles expiry. */
  readonly expiresAt?: number | null;
}

/** Returned only by an installed, trusted identity adapter, never by an operation input. */
export interface VerifiedIdentity {
  readonly user: ContextUser;
  readonly sessionId: string;
  readonly sessionKind?: SessionKind;
  readonly principalKind?: PrincipalKind | null;
  readonly tokenScope?: { readonly tokenId: string } | null;
  readonly credential?: CredentialRestrictions | null;
}

/** Transport-free application context. Roles are refreshed from membership at use time. */
export interface ExecutionContext {
  readonly userId: string;
  readonly user: ContextUser;
  readonly organizationId: string;
  readonly role: ContextRole;
  readonly membershipId: string;
  readonly sessionId: string;
  readonly sessionKind: SessionKind;
  readonly principalKind?: PrincipalKind | null;
  readonly tokenScope?: { readonly tokenId: string } | null;
  readonly credential?: CredentialRestrictions | null;
  /** Native scopes are fixed; legacy HTTP detail routes may derive scope from a resource. */
  readonly scopeMode?: "fixed" | "resource";
  readonly clientIp: string | null;
  readonly userAgent: string | null;
  readonly traceId: string;
  readonly source?: "dashboard" | "mcp" | "cli" | "api" | "webhook" | "system";
  readonly sourceClientId?: string | null;
}

/** Copy only application fields; never traverse an HTTP context or retain mutable identity objects. */
export function freezeContext(ctx: ExecutionContext): ExecutionContext {
  return Object.freeze({
    userId: ctx.userId,
    user: Object.freeze({
      id: ctx.user?.id ?? ctx.userId,
      email: ctx.user?.email ?? "",
      name: ctx.user?.name ?? null,
    }),
    organizationId: ctx.organizationId,
    role: ctx.role,
    membershipId: ctx.membershipId,
    sessionId: ctx.sessionId,
    sessionKind: ctx.sessionKind,
    principalKind: ctx.principalKind ?? null,
    tokenScope: ctx.tokenScope ? Object.freeze({ tokenId: ctx.tokenScope.tokenId }) : null,
    credential: ctx.credential
      ? Object.freeze({
          organizationId: ctx.credential.organizationId,
          readOnly: ctx.credential.readOnly,
          expiresAt: ctx.credential.expiresAt,
        })
      : null,
    scopeMode: ctx.scopeMode ?? "resource",
    clientIp: ctx.clientIp,
    userAgent: ctx.userAgent,
    traceId: ctx.traceId,
    source: ctx.source,
    sourceClientId: ctx.sourceClientId ?? null,
  });
}
