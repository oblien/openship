import { isMap, parseDocument } from "yaml";

export const WORKFLOW_EVENTS = [
  "workflow_dispatch",
  "push",
  "pull_request",
  "schedule",
  "repository_dispatch",
] as const;
export type WorkflowEvent = (typeof WORKFLOW_EVENTS)[number];
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export function workflowDocument(source: string) {
  const doc = parseDocument(source, { version: "1.2", uniqueKeys: true });
  if (doc.errors.length) throw new Error(doc.errors[0]!.message);
  // Bound aliases before conversion, including user-pasted documents.
  doc.toJS({ maxAliasCount: 50 });
  return doc;
}
export function workflowTriggers(source: string): Record<string, unknown> {
  const value = object(workflowDocument(source).toJS({ maxAliasCount: 50 })).on;
  return typeof value === "string"
    ? { [value]: {} }
    : Array.isArray(value)
      ? Object.fromEntries(value.map((key) => [String(key), {}]))
      : object(value);
}

/** Edit only the on: mapping; YAML comments and job definitions stay in the document. */
export function editWorkflowTrigger(
  source: string,
  event: WorkflowEvent,
  value: unknown | undefined,
): string {
  const doc = workflowDocument(source);
  const current = workflowTriggers(source);
  if (value === undefined) delete current[event];
  else current[event] = value;
  // Materialize shorthand once, then edit individual nodes to retain other event comments.
  const on = doc.get("on", true);
  if (!isMap(on)) doc.set("on", current);
  else if (value === undefined) doc.deleteIn(["on", event]);
  else doc.setIn(["on", event], value);
  return String(doc);
}
export function workflowEventConfig(value: unknown) {
  return object(value);
}
export function workflowPatterns(value: unknown) {
  return Array.isArray(value) ? value.join("\n") : "";
}
export function parseWorkflowPatterns(value: string) {
  return value
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
}
