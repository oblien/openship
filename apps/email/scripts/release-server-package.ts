type DependencyMap = Record<string, string>;

function dependencyMap(value: unknown, label: string): DependencyMap {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a package-to-version map`);
  }
  for (const [name, version] of Object.entries(value)) {
    if (typeof version !== 'string' || !version.trim() || version.startsWith('workspace:')) {
      throw new Error(`Release ${label} has an invalid or workspace-coupled version for "${name}"`);
    }
  }
  return Object.fromEntries(Object.entries(value)) as DependencyMap;
}

/** Shared by the container and tarball builder. Never carry install hooks or dev dependencies. */
export function createReleaseServerPackage(source: Record<string, unknown>) {
  const dependencies = dependencyMap(source.dependencies, 'dependencies');
  const overrides = dependencyMap(source.overrides, 'overrides');
  for (const [name, version] of Object.entries(overrides)) {
    // Only propagate an explicit runtime dependency's reviewed version policy.
    // Reject nested selectors, aliases and unrelated overrides instead of silently
    // losing a security constraint when synthesizing the production manifest.
    const registryPackage = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name);
    const registryRange = /^[~^<>=*v\d][\dA-Za-z.*+~^<>=| -]*$/.test(version);
    if (
      !registryPackage ||
      !registryRange ||
      !Object.hasOwn(dependencies, name) ||
      dependencies[name] !== version
    ) {
      throw new Error(`Release override "${name}" must match its explicit runtime dependency`);
    }
  }
  return {
    name: '@zero/server',
    version: source.version ?? '0.0.0',
    private: true,
    type: 'module',
    scripts: { start: 'bun run src/main.ts' },
    dependencies,
    ...(Object.keys(overrides).length ? { overrides } : {}),
  };
}
