/**
 * Credential validation schemas — TypeBox, because `secureRouter` auto-wires
 * `tbValidator("json", body)` from a route's `body` field and a Zod object reaches
 * `Value.Check` without a `[Kind]` symbol and throws on every request, valid or not.
 */

import { Type, type Static } from "@sinclair/typebox";

/**
 * Field values, as a flat map.
 *
 * Deliberately NOT a per-provider shape: the field list lives in `CREDENTIAL_PROVIDERS`
 * (@repo/core) and the service validates against it, so encoding one provider's fields
 * here would be a second declaration to keep in sync — and a new provider would need a
 * schema change to be submittable at all.
 *
 * Values are bounded because they are stored encrypted: unbounded strings are a cheap way
 * to write megabytes of ciphertext per row. 4096 fits an SSH private key, which is the
 * largest secret any planned provider carries.
 */
const CredentialValues = Type.Record(
  Type.String({ minLength: 1, maxLength: 64 }),
  Type.String({ maxLength: 4096 }),
);

export const CreateCredentialBody = Type.Object({
  /** Checked against the registry by the service — an unknown id is a 400 there. */
  provider: Type.String({ minLength: 1, maxLength: 64 }),
  name: Type.String({ minLength: 1, maxLength: 100 }),
  /** The resource this credential is for (a registry host); omitted for org-wide providers. */
  selector: Type.Optional(Type.Union([Type.String({ maxLength: 253 }), Type.Null()])),
  values: CredentialValues,
});

export type TCreateCredentialBody = Static<typeof CreateCredentialBody>;

export const UpdateCredentialBody = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  selector: Type.Optional(Type.Union([Type.String({ maxLength: 253 }), Type.Null()])),
  /** Omit a secret to keep the stored one — see the service's "leave blank to keep". */
  values: Type.Optional(CredentialValues),
});

export type TUpdateCredentialBody = Static<typeof UpdateCredentialBody>;
