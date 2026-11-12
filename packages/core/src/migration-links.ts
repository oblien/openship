export type MigrationSourceKind = "server" | "railway" | "vercel";

/** URL hints only select a source; the existing wizard still owns every action. */
export function parseMigrationSource(value: unknown): MigrationSourceKind | null {
  return value === "server" || value === "railway" || value === "vercel" ? value : null;
}

export function migrationHref(source?: MigrationSourceKind | null): string {
  return source ? `/library/migrate?from=${source}` : "/library/migrate";
}
