/**
 * System-component prerequisite policy.
 *
 * Keep this independent from the control plane's DEPLOY_MODE. That value says
 * how Openship itself is running; it cannot describe a remote deployment box.
 */

/** Every managed remote deployment target needs these core tools. */
export const REMOTE_SERVER_REQUIRED_COMPONENTS = ["docker", "git"] as const;

/** Direct runtime dependencies between installable system components. */
const SYSTEM_COMPONENT_DEPENDENCIES: Readonly<Record<string, readonly string[]>> = {
  // The managed edge is always the openship-edge container. There is no
  // host-OpenResty fallback, so Docker must be ready before any edge image work.
  edge: ["docker"],
};

/** Direct dependencies for one component. The returned array is immutable. */
function getSystemComponentDependencies(name: string): readonly string[] {
  return SYSTEM_COMPONENT_DEPENDENCIES[name] ?? [];
}

/**
 * Expand and topologically order an installation request.
 *
 * Dependencies are inserted once, before their consumers, while unrelated
 * components retain the caller's order. This is the one planner used by the
 * API setup endpoints and SystemManager, so `edge,docker`, `edge`, and a full
 * setup can never grow different ordering rules.
 */
export function resolveSystemComponentInstallPlan(requested: readonly string[]): string[] {
  const ordered: string[] = [];
  const resolved = new Set<string>();
  const visiting = new Set<string>();

  const visit = (name: string) => {
    if (resolved.has(name)) return;
    if (visiting.has(name)) {
      throw new Error(`Cyclic system component dependency involving "${name}"`);
    }

    visiting.add(name);
    for (const dependency of getSystemComponentDependencies(name)) visit(dependency);
    visiting.delete(name);
    resolved.add(name);
    ordered.push(name);
  };

  for (const name of requested) visit(name);
  return ordered;
}
