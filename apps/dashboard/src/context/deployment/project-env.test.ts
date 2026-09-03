import { ENV_MASK } from "@repo/core";
import { describe, expect, it } from "vitest";
import type { EnvironmentVariable } from "@/components/import-project/types";
import { planProjectEnvPersistence, type PersistedProjectEnvVar } from "./project-env";

const saved = (
  id: string,
  key: string,
  value: string,
  isSecret = false,
): PersistedProjectEnvVar => ({ id, key, value, isSecret });

const row = (
  key: string,
  value: string,
  options: Partial<EnvironmentVariable> = {},
): EnvironmentVariable => ({ key, value, visible: true, ...options });

function existingPlan(rows: EnvironmentVariable[], persisted: PersistedProjectEnvVar[]) {
  const result = planProjectEnvPersistence(rows, persisted, true);
  if (!result.ok) throw new Error(result.error);
  return result;
}

describe("planProjectEnvPersistence", () => {
  it("never sends or overwrites an untouched masked secret", () => {
    const persisted = [saved("env-1", "API_KEY", ENV_MASK, true)];
    const plan = existingPlan(
      [row("API_KEY", ENV_MASK, { sourceId: "env-1", isSecret: true })],
      persisted,
    );

    expect(plan.merge).toEqual({ upserts: [], deletes: [] });
    expect(plan.deployEnvVars).toBeUndefined();
  });

  it("turns an edited secret into exactly one secret upsert", () => {
    const persisted = [saved("env-1", "API_KEY", ENV_MASK, true)];
    const plan = existingPlan(
      [row("API_KEY", "replacement", { sourceId: "env-1", isSecret: true })],
      persisted,
    );

    expect(plan.merge).toEqual({
      upserts: [{ key: "API_KEY", value: "replacement", isSecret: true }],
      deletes: [],
    });
  });

  it("deletes a persisted variable when its row is removed", () => {
    const plan = existingPlan([], [saved("env-1", "OLD_KEY", "old")]);
    expect(plan.merge).toEqual({ upserts: [], deletes: ["OLD_KEY"] });
  });

  it("renames a persisted variable with an upsert and delete", () => {
    const plan = existingPlan(
      [row("NEW_KEY", "value", { sourceId: "env-1", isSecret: false })],
      [saved("env-1", "OLD_KEY", "value")],
    );
    expect(plan.merge).toEqual({
      upserts: [{ key: "NEW_KEY", value: "value", isSecret: false }],
      deletes: ["OLD_KEY"],
    });
  });

  it("omits envVars from an existing-project deploy after planning its merge", () => {
    const plan = existingPlan(
      [row("PUBLIC_URL", "https://new.example", { sourceId: "env-1", isSecret: false })],
      [saved("env-1", "PUBLIC_URL", "https://old.example")],
    );

    expect(plan.merge?.upserts).toEqual([
      { key: "PUBLIC_URL", value: "https://new.example", isSecret: false },
    ]);
    expect(plan.deployEnvVars).toBeUndefined();
  });

  it("still sends entered values when deploying a brand-new project", () => {
    const result = planProjectEnvPersistence(
      [row("PUBLIC_URL", "https://example.com"), row("API_SECRET", "secret")],
      [],
      false,
    );
    if (!result.ok) throw new Error(result.error);

    expect(result.merge).toBeNull();
    expect(result.deployEnvVars).toEqual({
      PUBLIC_URL: "https://example.com",
      API_SECRET: "secret",
    });
  });

  it("infers secret status for a new row added to an existing project", () => {
    const plan = existingPlan([row("DATABASE_PASSWORD", "secret")], []);
    expect(plan.merge?.upserts).toEqual([
      { key: "DATABASE_PASSWORD", value: "secret", isSecret: true },
    ]);
  });

  it("rejects renaming a masked secret without entering a replacement", () => {
    const result = planProjectEnvPersistence(
      [row("RENAMED", ENV_MASK, { sourceId: "env-1", isSecret: true })],
      [saved("env-1", "API_KEY", ENV_MASK, true)],
      true,
    );

    expect(result).toMatchObject({ ok: false });
  });
});
