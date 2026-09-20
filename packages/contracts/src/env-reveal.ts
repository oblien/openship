import { Type, type Static } from "@sinclair/typebox";

/** Request editable source values with the scan instead of fetching them later. */
export const SourceScanOptionsSchema = Type.Object({
  includeEnv: Type.Optional(Type.Boolean({
    description: "Include source environment values for editing. Requires permission to read source contents.",
  })),
});
export type SourceScanOptions = Static<typeof SourceScanOptionsSchema>;

/** Shared selection limits for saved services and source previews. */
export const MAX_REVEAL_KEYS = 500;
export const MAX_REVEAL_KEY_LENGTH = 512;
export const EnvRevealKeysSchema = Type.Array(
  Type.String({ minLength: 1, maxLength: MAX_REVEAL_KEY_LENGTH }),
  { minItems: 1, maxItems: MAX_REVEAL_KEYS },
);
