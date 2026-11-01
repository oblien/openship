/**
 * Fine-grained grant capabilities — `<area>:<verb>` entries a grant's
 * `permissions` may carry next to the coarse levels read / write / admin.
 *
 * A coarse level covers every route of the resource tree at that level and
 * below. A capability covers one slice of it: `domains:delete` on a project
 * authorizes `DELETE /api/domains/:id` for that project's domains and nothing
 * else on the project. A grant may hold only capabilities, only levels, or both.
 *
 * ── How a route reaches a capability ────────────────────────────────────────
 * Route tags already name a resource and an action (`domain:admin`). Each area
 * below claims one resource type and maps its verbs onto those actions, so
 * `capabilityFor("domain", "admin")` is `domains:delete`. The permission check
 * resolves the resource to its root (the project) and accepts the root grant
 * when its coarse level permits the action OR it holds that capability. A
 * project-level check made on behalf of a child collection (list a project's
 * domains, trigger a deploy) names the capability explicitly.
 *
 * ── Compatibility ───────────────────────────────────────────────────────────
 * Coarse levels keep their meaning and expand to the capabilities of their
 * level (`capabilitiesImpliedBy`): project `write` implies `domains:read`,
 * `domains:write`, `deployments:read` and `deployments:trigger`; `admin` adds
 * `domains:delete`. Existing grants are unchanged.
 *
 * Resource types without an area here stay on the coarse levels only.
 */

export const CAPABILITY_AREAS = {
  domains: {
    /** The grant type the capability is held on. */
    root: "project",
    /** The route resource type whose tags it covers. */
    resource: "domain",
    /** verb → the route action it authorizes. */
    verbs: { read: "read", write: "write", delete: "admin" },
  },
  deployments: {
    root: "project",
    resource: "deployment",
    verbs: { read: "read", trigger: "write" },
  },
} as const;

type Areas = typeof CAPABILITY_AREAS;
export type CapabilityArea = keyof Areas;
export type Capability = {
  [A in CapabilityArea]: `${A}:${Extract<keyof Areas[A]["verbs"], string>}`;
}[CapabilityArea];
type CoarseAction = "read" | "write" | "admin";

const ENTRIES = (Object.keys(CAPABILITY_AREAS) as CapabilityArea[]).flatMap((area) =>
  Object.entries(CAPABILITY_AREAS[area].verbs).map(([verb, action]) => ({
    capability: `${area}:${verb}` as Capability,
    area,
    root: CAPABILITY_AREAS[area].root as string,
    resource: CAPABILITY_AREAS[area].resource as string,
    action: action as CoarseAction,
  })),
);
const BY_CAPABILITY = new Map(ENTRIES.map((e) => [e.capability as string, e]));
const RANK: Record<CoarseAction, number> = { read: 1, write: 2, admin: 3 };

/** Every capability, in display order (area, then verb as declared). */
export const CAPABILITIES: readonly Capability[] = ENTRIES.map((e) => e.capability);

export function isCapability(value: unknown): value is Capability {
  return typeof value === "string" && BY_CAPABILITY.has(value);
}

/** The capability a `resourceType` route asserting `action` maps to, if any. */
export function capabilityFor(resourceType: string, action: string): Capability | null {
  return (
    ENTRIES.find((e) => e.resource === resourceType && e.action === action)?.capability ?? null
  );
}

/** The coarse action a capability stands for — the authority needed to grant it. */
export function capabilityAction(capability: Capability): CoarseAction {
  return BY_CAPABILITY.get(capability)!.action;
}

/** The grant type a capability must be held on. */
export function capabilityRoot(capability: Capability): string {
  return BY_CAPABILITY.get(capability)!.root;
}

/** Capabilities held on grants of `rootType`. */
export function capabilitiesForRoot(rootType: string): Capability[] {
  return ENTRIES.filter((e) => e.root === rootType).map((e) => e.capability);
}

/** The capabilities a set of coarse levels already implies — the compatibility expansion. */
export function capabilitiesImpliedBy(
  permissions: readonly string[],
  rootType = "project",
): Capability[] {
  const level = Math.max(0, ...permissions.map((p) => RANK[p as CoarseAction] ?? 0));
  return ENTRIES.filter((e) => e.root === rootType && RANK[e.action] <= level).map(
    (e) => e.capability,
  );
}
