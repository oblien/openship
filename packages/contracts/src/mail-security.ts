import { FormatRegistry, Type, type Static } from "@sinclair/typebox";
import { ipAddressVersion } from "@repo/core";

// TypeBox's value validator requires explicit implementations of JSON Schema formats.
// Use the same browser-safe address parser in requests, command builders and forms.
FormatRegistry.Set("ipv4", (value) => ipAddressVersion(value) === 4);
FormatRegistry.Set("ipv6", (value) => ipAddressVersion(value) === 6);

export const Fail2banIpSchema = Type.Union([
  Type.String({ format: "ipv4", maxLength: 15 }),
  Type.String({ format: "ipv6", maxLength: 45 }),
]);
export const Fail2banJailSchema = Type.String({
  // Absolute end assertion also rejects a final newline (which `$` alone accepts).
  minLength: 1,
  maxLength: 64,
  pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]*(?![\\s\\S])",
});
const counter = Type.Integer({ minimum: 0 });
export const MailFail2banJailSchema = Type.Object({
  jail: Fail2banJailSchema,
  currentlyFailed: counter,
  totalFailed: counter,
  currentlyBanned: counter,
  totalBanned: counter,
  bannedIps: Type.Array(Fail2banIpSchema),
});
export const MailFail2banSnapshotSchema = Type.Object({
  jails: Type.Array(Fail2banJailSchema, { maxItems: 64 }),
  details: Type.Record(Type.String(), MailFail2banJailSchema),
  checkedAt: Type.String(),
});
export const MailFail2banStatusSchema = Type.Object({
  ...MailFail2banSnapshotSchema.properties,
  canManage: Type.Boolean(),
});
export const MailFail2banActionSchema = Type.Object({
  success: Type.Literal(true),
  output: Type.String(),
});
export type MailFail2banJail = Static<typeof MailFail2banJailSchema>;
export type MailFail2banSnapshot = Static<typeof MailFail2banSnapshotSchema>;
export type MailFail2banStatus = Static<typeof MailFail2banStatusSchema>;
export type MailFail2banAction = Static<typeof MailFail2banActionSchema>;
