export interface EnvironmentIdentity {
  id: string;
  type?: "production" | "preview" | "development";
}

const environmentRank = (environment: EnvironmentIdentity) => {
  switch (environment.type) {
    case "production":
      return 0;
    case "preview":
      return 1;
    case "development":
      return 2;
    default:
      return 3;
  }
};

/** Keep the API's production/preview/development ordering during an optimistic insert. */
export function upsertProjectEnvironment<T extends EnvironmentIdentity>(
  environments: readonly T[],
  created: T,
): T[] {
  const next = environments.filter((environment) => environment.id !== created.id);
  next.push(created);
  return next
    .map((environment, index) => ({ environment, index }))
    .sort(
      (left, right) =>
        environmentRank(left.environment) - environmentRank(right.environment) ||
        left.index - right.index,
    )
    .map(({ environment }) => environment);
}

export function removeProjectEnvironment<T extends EnvironmentIdentity>(
  environments: readonly T[],
  deletedId: string,
): T[] {
  return environments.filter((environment) => environment.id !== deletedId);
}

export function firstProjectEnvironment<T extends EnvironmentIdentity>(
  environments: readonly T[],
): T | null {
  return (
    environments.reduce<T | null>((best, environment) => {
      if (!best) return environment;
      return environmentRank(environment) < environmentRank(best) ? environment : best;
    }, null) ?? null
  );
}

/** Every /info cache contains the shared environment list, so all known ids are affected. */
export function projectEnvironmentIds(
  currentId: string,
  environments: readonly EnvironmentIdentity[],
): string[] {
  return [
    ...new Set([currentId, ...environments.map((environment) => environment.id)].filter(Boolean)),
  ];
}

export function projectEnvironmentHref(environmentId: string, activeTab: string): string {
  return `/projects/${environmentId}/${activeTab}`;
}

interface ReconcileCreatedEnvironmentOptions<T extends EnvironmentIdentity> {
  currentId: string;
  environments: readonly T[];
  created: T;
  refresh: () => Promise<T[]>;
  commit: (environments: T[]) => void;
  invalidate: (ids: string[]) => void;
  onRefreshError?: (error: unknown) => void;
}

/**
 * Commit a successful create immediately, then reconcile its shared list.
 * A failed follow-up read must not turn the already-persisted mutation into a
 * user-visible create failure.
 */
export async function reconcileCreatedProjectEnvironment<T extends EnvironmentIdentity>({
  currentId,
  environments,
  created,
  refresh,
  commit,
  invalidate,
  onRefreshError,
}: ReconcileCreatedEnvironmentOptions<T>): Promise<void> {
  const optimistic = upsertProjectEnvironment(environments, created);
  commit(optimistic);
  invalidate(projectEnvironmentIds(currentId, optimistic));

  try {
    const refreshed = await refresh();
    commit(refreshed);
    invalidate(projectEnvironmentIds(currentId, [...optimistic, ...refreshed]));
  } catch (error) {
    onRefreshError?.(error);
  }
}
