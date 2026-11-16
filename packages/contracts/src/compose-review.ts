import { Type } from "@sinclair/typebox";

/** Project-scoped digest of the Compose source actually shown to the operator. */
export const ComposeRevisionSchema = Type.String({
  pattern: "^[a-f0-9]{64}$",
  description: "Reviewed Compose source revision. A stale revision is rejected before synchronization.",
});

export interface ComposeChanges {
  added: string[];
  changed: string[];
  removed: string[];
}

export interface ComposeServiceDiff {
  name: string;
  kind: keyof ComposeChanges;
  fields: Array<{ path: string; before: string | null; after: string | null }>;
}

/** Display only. Never submit these masked values as deployment configuration. */
export interface ComposeReview {
  projectId: string;
  composeRevision: string;
  composeChanges: ComposeChanges;
  composeDiff: ComposeServiceDiff[];
}
