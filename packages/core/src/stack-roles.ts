// Pure: detection (reading the Gemfile, walking the tree) is the caller's job.

import type { StackRole } from "./stacks";

export interface ResolveStackRolesInput {
  /** Non-web preset roles registered on the stack (STACKS[id].defaultRoles). */
  defaultRoles?: readonly StackRole[];
  /** Dependency names detected in the project (e.g. parsed Gemfile gems). */
  deps?: readonly string[];
  /** File paths detected in the project (e.g. "bin/jobs"). */
  files?: readonly string[];
  /**
   * openship.json `roles`, when the field is present AT ALL - including `[]`.
   * Leave undefined when the config has no `roles` key so presets can apply;
   * an explicit array (empty or not) replaces presets entirely.
   */
  configRoles?: readonly StackRole[];
}

function matchesWhen(role: StackRole, deps: ReadonlySet<string>, files: ReadonlySet<string>): boolean {
  const when = role.when;
  if (!when) return true;
  if (when.deps && !when.deps.every((d) => deps.has(d.toLowerCase()))) return false;
  if (when.files && !when.files.every((f) => files.has(f))) return false;
  return true;
}

/** Explicit config roles win; otherwise matching presets, minus ambiguous kinds. */
export function resolveStackRoles(input: ResolveStackRolesInput): StackRole[] {
  if (input.configRoles !== undefined) return [...input.configRoles];

  const deps = new Set((input.deps ?? []).map((d) => d.toLowerCase()));
  const files = new Set(input.files ?? []);
  const matched = (input.defaultRoles ?? []).filter((role) => matchesWhen(role, deps, files));

  const countByKind = new Map<string, number>();
  for (const role of matched) {
    countByKind.set(role.kind, (countByKind.get(role.kind) ?? 0) + 1);
  }
  return matched.filter((role) => countByKind.get(role.kind) === 1);
}
