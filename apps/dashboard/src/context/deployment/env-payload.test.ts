import { describe, expect, it } from "vitest";
import { ENV_MASK } from "@repo/core";
import type { EnvironmentVariable } from "@/components/import-project/types";
import type { PersistedProjectEnv } from "@/lib/project-env-diff";
import {
  mergePreparedSourceEnv,
  planDeploymentEnvPersistence,
  planMatchedExistingProjectEnvPersistence,
} from "./env-payload";

const row = (
  key: string,
  value: string,
  options: Partial<EnvironmentVariable> = {},
): EnvironmentVariable => ({ key, value, visible: true, ...options });

const saved = (key: string, value: string, isSecret = false): PersistedProjectEnv => ({
  key,
  value,
  isSecret,
});

describe("mergePreparedSourceEnv", () => {
  it("activates openship.json keys, keeps .env opt-in, and preserves operator overrides", () => {
    const result = mergePreparedSourceEnv(
      [row("SHARED", "operator")],
      {
        DECLARED: ENV_MASK,
        SHARED: ENV_MASK,
        DOT_ENV_ONLY: ENV_MASK,
      },
      ["DECLARED", "SHARED"],
    );

    expect(result.envVars).toEqual([
      row("SHARED", "operator"),
      row("DECLARED", ENV_MASK, { preserveValue: true }),
    ]);
    expect(result.rootEnvVars).toEqual([row("DOT_ENV_ONLY", ENV_MASK, { preserveValue: true })]);
  });
});

describe("planDeploymentEnvPersistence", () => {
  it("sends entered and source-owned values through build/access for a new project", () => {
    const result = planDeploymentEnvPersistence({
      envVars: [
        row("PUBLIC_SETTING", "enabled"),
        row("OPTIONAL", ""),
        row("DECLARED_BY_SOURCE", ENV_MASK, { preserveValue: true }),
      ],
      baseline: null,
    });

    expect(result).toEqual({
      ok: true,
      merge: null,
      buildAccessEnvVars: {
        PUBLIC_SETTING: "enabled",
        OPTIONAL: "",
        DECLARED_BY_SOURCE: ENV_MASK,
      },
    });
  });

  it("plans a partial merge and omits the full build/access payload for an existing project", () => {
    const result = planDeploymentEnvPersistence({
      projectId: "project-1",
      envVars: [
        row("AUTH_SECRET", "replacement", {
          originalKey: "AUTH_SECRET",
          isSecret: true,
        }),
        row("PUBLIC_SETTING", "enabled", {
          originalKey: "PUBLIC_SETTING",
          isSecret: false,
        }),
      ],
      baseline: [saved("AUTH_SECRET", ENV_MASK, true), saved("PUBLIC_SETTING", "enabled")],
    });

    expect(result).toEqual({
      ok: true,
      merge: {
        upserts: [{ key: "AUTH_SECRET", value: "replacement", isSecret: true }],
        deletes: [],
      },
      buildAccessEnvVars: undefined,
    });
  });

  it("omits an untouched saved secret from the existing-project merge", () => {
    const result = planDeploymentEnvPersistence({
      projectId: "project-1",
      envVars: [
        row("AUTH_SECRET", "", {
          originalKey: "AUTH_SECRET",
          preserveValue: true,
          isSecret: true,
        }),
      ],
      baseline: [saved("AUTH_SECRET", ENV_MASK, true)],
    });

    expect(result).toEqual({
      ok: true,
      merge: { upserts: [], deletes: [] },
      buildAccessEnvVars: undefined,
    });
  });

  it("sends untracked preserved rows as explicit server-side source imports", () => {
    const result = planDeploymentEnvPersistence({
      projectId: "project-1",
      envVars: [
        row("SAVED", "same", { originalKey: "SAVED", isSecret: false }),
        row("SOURCE_DEFAULT", ENV_MASK, { preserveValue: true }),
      ],
      baseline: [saved("SAVED", "same")],
    });

    expect(result).toEqual({
      ok: true,
      merge: { upserts: [], deletes: [] },
      buildAccessEnvVars: undefined,
      sourceEnvKeys: ["SOURCE_DEFAULT"],
    });
  });

  it("fails closed when an existing project's environment was not loaded", () => {
    const result = planDeploymentEnvPersistence({
      projectId: "project-1",
      envVars: [],
      baseline: null,
    });

    expect(result).toMatchObject({ ok: false });
  });
});

describe("planMatchedExistingProjectEnvPersistence", () => {
  it("preserves saved rows omitted by a wizard that ensure matched to an existing project", () => {
    const result = planMatchedExistingProjectEnvPersistence({
      envVars: [row("NEW_SETTING", "new")],
      persisted: {
        rows: [
          row("AUTH_SECRET", "", {
            originalKey: "AUTH_SECRET",
            preserveValue: true,
            isSecret: true,
          }),
          row("EXISTING_SETTING", "keep", {
            originalKey: "EXISTING_SETTING",
            isSecret: false,
          }),
        ],
        baseline: [saved("AUTH_SECRET", ENV_MASK, true), saved("EXISTING_SETTING", "keep")],
      },
    });

    expect(result).toEqual({
      ok: true,
      merge: {
        upserts: [{ key: "NEW_SETTING", value: "new", isSecret: false }],
        deletes: [],
      },
      buildAccessEnvVars: undefined,
    });
  });

  it("adopts a matching saved key and preserves an unreadable secret", () => {
    const result = planMatchedExistingProjectEnvPersistence({
      envVars: [row("AUTH_SECRET", ENV_MASK, { preserveValue: true })],
      persisted: {
        rows: [
          row("AUTH_SECRET", "", {
            originalKey: "AUTH_SECRET",
            preserveValue: true,
            isSecret: true,
          }),
        ],
        baseline: [saved("AUTH_SECRET", ENV_MASK, true)],
      },
    });

    expect(result).toEqual({
      ok: true,
      merge: { upserts: [], deletes: [] },
      buildAccessEnvVars: undefined,
    });
  });

  it("applies an explicitly entered replacement to a matching saved secret", () => {
    const result = planMatchedExistingProjectEnvPersistence({
      envVars: [row("AUTH_SECRET", "replacement")],
      persisted: {
        rows: [
          row("AUTH_SECRET", "", {
            originalKey: "AUTH_SECRET",
            preserveValue: true,
            isSecret: true,
          }),
        ],
        baseline: [saved("AUTH_SECRET", ENV_MASK, true)],
      },
    });

    expect(result).toEqual({
      ok: true,
      merge: {
        upserts: [{ key: "AUTH_SECRET", value: "replacement", isSecret: true }],
        deletes: [],
      },
      buildAccessEnvVars: undefined,
    });
  });

  it("keeps an untracked masked source selection without replacing saved rows", () => {
    const result = planMatchedExistingProjectEnvPersistence({
      envVars: [row("IMPORTED_FROM_DOTENV", ENV_MASK, { preserveValue: true })],
      persisted: {
        rows: [
          row("AUTH_SECRET", "", {
            originalKey: "AUTH_SECRET",
            preserveValue: true,
            isSecret: true,
          }),
        ],
        baseline: [saved("AUTH_SECRET", ENV_MASK, true)],
      },
    });

    expect(result).toEqual({
      ok: true,
      merge: { upserts: [], deletes: [] },
      buildAccessEnvVars: undefined,
      sourceEnvKeys: ["IMPORTED_FROM_DOTENV"],
    });
  });
});
