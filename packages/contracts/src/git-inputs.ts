import { Type } from "@sinclair/typebox";

/** Provider-specific identity validation belongs to the selected adapter. */
export const GitProviderId = Type.String({ minLength: 1, maxLength: 64 });
export const GitNamespace = Type.String({ minLength: 1, maxLength: 512 });
export const GitRepositoryName = Type.String({ minLength: 1, maxLength: 200 });
