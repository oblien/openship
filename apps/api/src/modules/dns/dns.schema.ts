/**
 * DNS validation schemas — TypeBox for Hono route validation.
 *
 * `secureRouter` auto-wires `tbValidator("json", body)` from the route's `body`
 * field, so these must be TypeBox schemas: a Zod object reaches `Value.Check`
 * without a `[Kind]` symbol and throws on every request, valid or not.
 */

import { Type, type Static } from "@sinclair/typebox";

/** Same shape the domains module accepts, so "a hostname" means one thing. */
const Hostname = Type.String({
  minLength: 1,
  maxLength: 253,
  pattern: "^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\\.)+[a-zA-Z]{2,}$",
});

export const AddDnsCredentialBody = Type.Object({
  /** Literal union, not a free string: the registry is the source of truth and
   *  an unknown value should be rejected at the edge, not deep in a resolver. */
  provider: Type.Union([Type.Literal("cloudflare")]),
  name: Type.String({ minLength: 1, maxLength: 100 }),
  /** Bounded because it is stored encrypted — an unbounded body would be a
   *  cheap way to write megabytes of ciphertext per row. */
  apiToken: Type.String({ minLength: 1, maxLength: 500 }),
});

export type TAddDnsCredentialBody = Static<typeof AddDnsCredentialBody>;

export const VerifyZoneBody = Type.Object({
  /** Bounded on purpose: zone discovery walks this name's suffixes and spends an
   *  outbound provider call per candidate. */
  hostname: Hostname,
});

export type TVerifyZoneBody = Static<typeof VerifyZoneBody>;
