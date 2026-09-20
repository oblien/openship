import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ValidationError } from "@repo/core";

const cleaningSchemas = new WeakMap<TSchema, TSchema>();
function cleaningSchema(schema: TSchema): TSchema {
  const existing = cleaningSchemas.get(schema);
  if (existing) return existing;
  // TypeBox Clean removes undeclared keys even with additionalProperties:true.
  // Explicitly open payloads (Compose extensions, provider config) are part of
  // the contract. Express their allowed extras as a schema for the cleaner.
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (value === null || typeof value !== "object") return value;
    const copy = { ...value } as Record<string, unknown>;
    for (const [key, item] of Object.entries(copy)) copy[key] = key === "additionalProperties" && item === true ? Type.Unknown() : visit(item);
    return copy;
  };
  const result = visit(schema) as TSchema;
  cleaningSchemas.set(schema, result);
  return result;
}

/** Detach public JSON input before asynchronous identity and authorization work. */
export function parseInput<T extends TSchema>(schema: T, value: unknown): Static<T> {
  let snapshot: unknown;
  try { snapshot = structuredClone(value); }
  catch { throw new ValidationError("Input must contain serializable data"); }
  if (!Value.Check(schema, snapshot)) {
    const details: Record<string, string[]> = {};
    for (const error of Value.Errors(schema, snapshot))
      (details[error.path || "/"] ??= []).push(error.message);
    throw new ValidationError("Invalid operation input", details);
  }
  // Preserve legacy HTTP compatibility with unknown fields while preventing
  // private engine options from reaching services through a public input.
  return Value.Clean(cleaningSchema(schema), snapshot) as Static<T>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
