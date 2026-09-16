import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/** Contracts describe authorized resource calls independently of HTTP envelopes. */
export interface ResourceOperationSchema {
  action: "read" | "write" | "admin";
  input?: TSchema;
  optionalInput?: true;
  output: TSchema;
  /** list permits filtered enumeration; all requires access to the whole collection. */
  scope?: "list" | "all";
  /** A project-creating operation may accept a constrained create-only grant. */
  projectCreate?: true;
  /** Reuse domain validators for metadata with an existing authoritative schema. */
  outputCheck?: (value: unknown) => boolean;
}
type ResourceMethod<S extends ResourceOperationSchema> = S extends {
  input: infer I extends TSchema;
}
  ? S extends { optionalInput: true }
    ? (id: string, input?: Static<I>) => Promise<Static<S["output"]>>
    : (id: string, input: Static<I>) => Promise<Static<S["output"]>>
  : (id: string) => Promise<Static<S["output"]>>;
export type ResourceOperations<S extends Record<string, ResourceOperationSchema>> = {
  [K in keyof S]: ResourceMethod<S[K]>;
};
export type ChildResourceOperations<S extends Record<string, ResourceOperationSchema>> = {
  [K in keyof S]: (
    parentId: string,
    ...args: Parameters<ResourceMethod<S[K]>>
  ) => ReturnType<ResourceMethod<S[K]>>;
};
/** Organization-scoped operations whose inputs do not include a resource id. */
export type ScopedOperations<S extends Record<string, ResourceOperationSchema>> = {
  [K in keyof S]: ResourceMethod<S[K]> extends (id: string, ...args: infer A) => infer R
    ? (...args: A) => R
    : never;
};

export function isResourceOutput<S extends ResourceOperationSchema>(
  schema: S,
  value: unknown,
): value is Static<S["output"]> {
  return Value.Check(schema.output, value) && (!schema.outputCheck || schema.outputCheck(value));
}
