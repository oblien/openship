/**
 * Domain validation schemas - TypeBox for Hono route validation.
 */

import { Type, type Static } from "@sinclair/typebox";

// ─── Route params ────────────────────────────────────────────────────────────

export const DomainIdParam = Type.Object({
  id: Type.String({ minLength: 1 }),
});

// ─── Query params ────────────────────────────────────────────────────────────

export const ListDomainsQuery = Type.Object({
  projectId: Type.String({ minLength: 1 }),
});

// ─── Request bodies ──────────────────────────────────────────────────────────

export const AddDomainBody = Type.Object({
  projectId: Type.String({ minLength: 1 }),
  hostname: Type.String({
    minLength: 1,
    maxLength: 253,
    pattern: "^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\\.)+[a-zA-Z]{2,}$",
  }),
  isPrimary: Type.Optional(Type.Boolean({ default: false })),
  /** Externally-managed ingress + TLS (Cloudflare Tunnel, LB): verify via TXT
   *  only, skip certbot, serve plain HTTP. Domain need not resolve to the box. */
  externalIngress: Type.Optional(Type.Boolean({ default: false })),
  /**
   * Also claim `www.<hostname>`. Creates a SECOND pending domain row — the SSL
   * layer's own `includeWww` only ever acted on an existing verified www ROW, so
   * without this the toggle was a no-op end to end (issue #289).
   */
  includeWww: Type.Optional(Type.Boolean({ default: false })),
});

/** Operator-supplied certificate (BYO / Cloudflare Origin CA) to install for a
 *  domain. The cert/key pair is validated (parse + key match) in the adapter. */
export const UploadCertBody = Type.Object({
  certPem: Type.String({ minLength: 1, maxLength: 100_000 }),
  keyPem: Type.String({ minLength: 1, maxLength: 100_000 }),
});

/** POST /preview — side-effect-free DNS-records preview for a hostname. */
export const PreviewDomainBody = Type.Object({
  hostname: Type.String({ minLength: 1, maxLength: 253, description: "Hostname to preview DNS records for." }),
});

// ─── Inferred types ──────────────────────────────────────────────────────────

export type TDomainIdParam = Static<typeof DomainIdParam>;
export type TListDomainsQuery = Static<typeof ListDomainsQuery>;
export type TAddDomainBody = Static<typeof AddDomainBody>;
export type TUploadCertBody = Static<typeof UploadCertBody>;
