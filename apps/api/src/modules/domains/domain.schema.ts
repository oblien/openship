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
   * Also claim `www.<hostname>` as a SECOND, fully independent domain row: its own
   * DNS record (returned in `records`), its own verification, its own certificate —
   * and its own failure. Created as a 301 to the bare hostname; the response
   * carries its id in `www`, or the reason it couldn't be claimed in `wwwError`.
   *
   * Nothing downstream treats the pair as one thing any more. `manageDomainSsl`
   * takes exactly one hostname, and `deployments/ssl/renew` runs the two
   * independently and reports both (issue #289 and its follow-ups).
   */
  includeWww: Type.Optional(Type.Boolean({ default: false })),
  /**
   * Serve a canonical redirect from this hostname to another hostname of the
   * SAME project instead of serving the app (see lib/domain-redirect.ts). This is
   * what makes `www.<apex>` an ordinary domain that points at its apex rather
   * than a flag on the apex row. Self-hosted only.
   */
  redirectTo: Type.Optional(Type.String({ minLength: 1, maxLength: 253 })),
  /** 301 (default) | 302 | 307 | 308. Only meaningful with `redirectTo`. */
  redirectStatus: Type.Optional(Type.Integer({ minimum: 300, maximum: 399 })),
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
  includeWww: Type.Optional(
    Type.Boolean({
      description:
        "Also return the records for the www.<hostname> sibling, matching the 'Include www' toggle. The toggle claims a SECOND hostname, so it needs its own record.",
    }),
  ),
});

// ─── Inferred types ──────────────────────────────────────────────────────────

export type TDomainIdParam = Static<typeof DomainIdParam>;
export type TListDomainsQuery = Static<typeof ListDomainsQuery>;
export type TAddDomainBody = Static<typeof AddDomainBody>;
export type TUploadCertBody = Static<typeof UploadCertBody>;
