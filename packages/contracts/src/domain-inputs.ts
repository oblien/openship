/**
 * Domain inputs shared by HTTP, native, and remote callers.
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

/**
 * Route this domain to one service, from the domain row itself. The service must
 * belong to the domain's project and `targetPort` must be one of its ports
 * (default: its primary port). Rows bound this way are not entries of the
 * service's `publicEndpoints`, so any number of them can share a service.
 */
const BindingServiceId = Type.String({ minLength: 1, maxLength: 128 });
const DomainServiceBindingFields = {
  serviceId: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "Service of the same project to route this domain to." })),
  targetPort: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535, description: "Container port of that service. Defaults to its primary port." })),
};

export const AddDomainBody = Type.Object({
  projectId: Type.String({ minLength: 1 }),
  hostname: Type.String({
    minLength: 1,
    maxLength: 253,
    pattern: "^(\\*\\.)?([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\\.)+[a-zA-Z]{2,}$",
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
  /** ACME challenge method: "http-01" (default) | "dns-01" (required for wildcards). */
  sslChallenge: Type.Optional(Type.Union([Type.Literal("http-01"), Type.Literal("dns-01")])),
  ...DomainServiceBindingFields,
});

/**
 * PATCH /:id — change the service binding this domain row owns. `serviceId: null`
 * unbinds the domain and removes its route. Closed so a misspelled field fails
 * the request rather than silently changing nothing.
 */
export const UpdateDomainBody = Type.Object(
  {
    serviceId: Type.Optional(
      Type.Union([BindingServiceId, Type.Null()], {
        description: "Service of the same project to route this domain to, or null to unbind it.",
      }),
    ),
    targetPort: DomainServiceBindingFields.targetPort,
  },
  { additionalProperties: false, minProperties: 1 },
);

/** Operator-supplied certificate (BYO / Cloudflare Origin CA) to install for a
 *  domain. The cert/key pair is validated (parse + key match) in the adapter. */
export const UploadCertBody = Type.Object({
  certPem: Type.String({ minLength: 1, maxLength: 100_000 }),
  keyPem: Type.String({ minLength: 1, maxLength: 100_000 }),
});

/** POST /preview — side-effect-free DNS-records preview for a hostname. */
export const PreviewDomainBody = Type.Object({
  hostname: Type.String({ minLength: 1, maxLength: 253, description: "Hostname to preview DNS records for." }),
  serverId: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 128,
      description: "Selected deployment server whose routing configuration determines the DNS records.",
    }),
  ),
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
export type TUpdateDomainBody = Static<typeof UpdateDomainBody>;
export type TUploadCertBody = Static<typeof UploadCertBody>;
