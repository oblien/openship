/**
 * Domain validation schemas — TypeBox for Hono route validation.
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
});

// ─── Inferred types ──────────────────────────────────────────────────────────

export type TDomainIdParam = Static<typeof DomainIdParam>;
export type TListDomainsQuery = Static<typeof ListDomainsQuery>;
export type TAddDomainBody = Static<typeof AddDomainBody>;
