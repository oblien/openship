/**
 * Safe YAML boundary for operator-provided Stack/Compose documents.
 *
 * Docker remains the authoritative Compose renderer, but OpenShip parses
 * source documents to validate paths and derive safe projections before a
 * manager command is constructed. Keep that local parser deliberately
 * conservative: no custom tags, bounded aliases, no circular values, and a
 * finite object graph.
 */

import { parseDocument } from "yaml";
import { AppError } from "@repo/core";

export const SWARM_YAML_MAX_ALIAS_COUNT = 64;
export const SWARM_YAML_MAX_DEPTH = 64;
export const SWARM_YAML_MAX_NODES = 25_000;

function invalidYaml(message: string, code = "SWARM_SOURCE_INVALID"): AppError {
  return new AppError(message, 400, code);
}

function assertYamlComplexity(value: unknown): void {
  const visited = new WeakSet<object>();
  const ancestors = new WeakSet<object>();
  let nodes = 0;

  const visit = (current: unknown, depth: number) => {
    if (depth > SWARM_YAML_MAX_DEPTH) {
      throw invalidYaml("Stack YAML exceeds the maximum nesting depth.", "SWARM_SOURCE_TOO_COMPLEX");
    }
    if (!current || typeof current !== "object") return;
    if (ancestors.has(current)) {
      throw invalidYaml("Stack YAML contains a circular alias.", "SWARM_SOURCE_TOO_COMPLEX");
    }
    // Shared YAML anchors are safe to reuse; inspect their object graph once.
    if (visited.has(current)) return;
    visited.add(current);
    ancestors.add(current);
    nodes += 1;
    if (nodes > SWARM_YAML_MAX_NODES) {
      throw invalidYaml("Stack YAML exceeds the maximum document complexity.", "SWARM_SOURCE_TOO_COMPLEX");
    }
    for (const child of Array.isArray(current) ? current : Object.values(current)) {
      visit(child, depth + 1);
    }
    ancestors.delete(current);
  };

  visit(value, 0);
}

/**
 * Parse only YAML 1.2 core values used by Compose. Callers receive the plain
 * JSON-compatible result or a stable error that never echoes source content.
 */
export function parseSafeSwarmYaml(source: string, label = "Stack YAML"): unknown {
  let document;
  try {
    document = parseDocument(source, {
      prettyErrors: false,
      customTags: [],
      maxAliasCount: SWARM_YAML_MAX_ALIAS_COUNT,
      uniqueKeys: true,
      version: "1.2",
    } as never);
  } catch {
    throw invalidYaml(label + " is not valid YAML.");
  }
  if (document.errors.length > 0) throw invalidYaml(label + " is not valid YAML.");
  // yaml reports an unresolved custom tag as a warning, so treat every parser
  // warning as an unsupported construct rather than silently coercing it.
  if (document.warnings.length > 0) {
    throw invalidYaml(label + " uses unsupported YAML tags.", "SWARM_SOURCE_YAML_TAG_UNSUPPORTED");
  }
  try {
    const parsed = document.toJSON();
    assertYamlComplexity(parsed);
    return parsed;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw invalidYaml(label + " exceeds safe YAML alias limits.", "SWARM_SOURCE_TOO_COMPLEX");
  }
}
