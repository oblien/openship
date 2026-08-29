import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { ENVIRONMENTS } from "@repo/core";
import {
  EnvironmentScopeSchema,
  parseOptionalEnvironmentScope,
} from "../../src/lib/environment-scope";

describe("environment scope", () => {
  it.each(ENVIRONMENTS)("accepts %s everywhere", (environment) => {
    expect(parseOptionalEnvironmentScope(environment)).toBe(environment);
    expect(Value.Check(EnvironmentScopeSchema, environment)).toBe(true);
  });

  it("allows an omitted optional scope", () => {
    expect(parseOptionalEnvironmentScope(undefined)).toBeUndefined();
  });

  it.each([null, 1, "staging"])("rejects invalid scope %j", (environment) => {
    expect(() => parseOptionalEnvironmentScope(environment)).toThrow("environment must be one of");
    expect(Value.Check(EnvironmentScopeSchema, environment)).toBe(false);
  });
});
