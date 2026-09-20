import { Type } from "@sinclair/typebox";
import { AppError, ENVIRONMENTS, type Environment } from "@repo/core";

/** One schema and parser backed by the canonical environment list in @repo/core. */
export const EnvironmentScopeSchema = Type.Union(
  ENVIRONMENTS.map((environment) => Type.Literal(environment)),
);

export function parseOptionalEnvironmentScope(value: unknown): Environment | undefined {
  if (value === undefined) return undefined;

  if (typeof value !== "string" || !ENVIRONMENTS.includes(value as Environment)) {
    throw new AppError(`environment must be one of: ${ENVIRONMENTS.join(", ")}`, 400);
  }

  return value as Environment;
}
