/** null means the whole project; an empty explicit selection means nothing. */
export type MigrationServiceScope = Set<string> | null;

export function toggleMigrationService(
  scope: MigrationServiceScope,
  name: string,
  allNames: readonly string[],
): MigrationServiceScope {
  const next = new Set(scope ?? allNames);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  return next;
}

export function validMigrationServiceScope(
  scope: MigrationServiceScope,
  allNames: readonly string[] | null,
): boolean {
  if (scope === null) return true;
  return allNames !== null && scope.size > 0 && [...scope].every((name) => allNames.includes(name));
}
