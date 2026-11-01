// Pure: detection (reading the Gemfile, walking the tree) is the caller's job.

import type { StackDefinition, StackRole } from "./stacks";

/** Preset matching metadata must never reach an enabled runtime role. */
export function runtimeRoleDefinition({
  when: _when,
  unless: _unless,
  slot: _slot,
  ...role
}: StackRole): StackRole {
  return role;
}

/**
 * Apply a stack's optional startup optimization to its resolved web command.
 *
 * Stack definitions supply the command; the resolver has no framework policy.
 * Without opt-in or a configured optimization, return the web command unchanged.
 * `&&` prevents server startup if optimization fails. Preserve any existing
 * `exec` in the web command, which lets the server replace its shell and receive
 * signals directly. Worker and scheduler commands do not pass through here.
 */
export function resolveWebCommand(
  input: Pick<StackDefinition, "optimizeCommand"> & {
    command: string;
    optimize?: boolean;
  },
): string {
  if (input.optimize !== true || !input.optimizeCommand) return input.command;
  return `${input.optimizeCommand} && ${input.command}`;
}

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

function matchesGates(role: StackRole, deps: ReadonlySet<string>, files: ReadonlySet<string>): boolean {
  const { when, unless } = role;
  if (when?.deps && !when.deps.every((d) => deps.has(d.toLowerCase()))) return false;
  if (when?.files && !when.files.every((f) => files.has(f))) return false;
  if (unless?.deps?.some((d) => deps.has(d.toLowerCase()))) return false;
  if (unless?.files?.some((f) => files.has(f))) return false;
  return true;
}

/** Explicit config roles win. Only presets competing for a declared slot are ambiguous. */
export function resolveStackRoles(input: ResolveStackRolesInput): StackRole[] {
  if (input.configRoles !== undefined) return [...input.configRoles];

  const deps = new Set((input.deps ?? []).map((d) => d.toLowerCase()));
  const files = new Set(input.files ?? []);
  const matched = (input.defaultRoles ?? []).filter((role) => matchesGates(role, deps, files));

  const countBySlot = new Map<string, number>();
  for (const role of matched) {
    if (role.slot) countBySlot.set(role.slot, (countBySlot.get(role.slot) ?? 0) + 1);
  }
  return matched.filter((role) => !role.slot || countBySlot.get(role.slot) === 1);
}
