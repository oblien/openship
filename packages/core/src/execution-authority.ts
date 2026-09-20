/** Persisted delegation for a saved action. Contains identifiers and limits, never bearer secrets or roles. */
export interface ExecutionAuthority {
  version: 1;
  userId: string;
  organizationId: string;
  token: { id: string; kind: "pat" | "oauth"; scoped: boolean } | null;
  restrictions: { organizationId: string | null; readOnly: boolean; expiresAt: number | null } | null;
}
