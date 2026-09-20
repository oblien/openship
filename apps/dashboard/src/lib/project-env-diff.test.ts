import { describe, expect, it } from "vitest";
import { ENV_MASK } from "@repo/core";
import type { EnvironmentVariable } from "@/components/import-project/types";
import {
  computeProjectEnvDiff,
  createProjectEnvEditState,
  type PersistedProjectEnv,
} from "./project-env-diff";

const saved = (key: string, value: string, isSecret = false): PersistedProjectEnv => ({
  key,
  value,
  isSecret,
});

const row = (
  key: string,
  value: string,
  options: Partial<EnvironmentVariable> = {},
): EnvironmentVariable => ({ key, value, visible: true, ...options });

const loaded = (
  key: string,
  value: string,
  options: Partial<EnvironmentVariable> = {},
): EnvironmentVariable => row(key, value, { originalKey: key, isSecret: false, ...options });

const secret = (key: string, options: Partial<EnvironmentVariable> = {}): EnvironmentVariable =>
  loaded(key, "", { preserveValue: true, isSecret: true, visible: false, ...options });

function diff(rows: EnvironmentVariable[], baseline: PersistedProjectEnv[]) {
  const result = computeProjectEnvDiff(rows, baseline);
  if (!result.ok) throw new Error(`Expected a diff, got: ${result.error}`);
  return result.diff;
}

describe("createProjectEnvEditState", () => {
  it("builds editable rows and the comparison baseline without exposing secret plaintext", () => {
    expect(
      createProjectEnvEditState([
        {
          key: "AUTH_SECRET",
          value: ENV_MASK,
          isSecret: true,
          environment: "production",
        },
        {
          key: "PUBLIC_SETTING",
          value: "enabled",
          isSecret: false,
          environment: "production",
        },
        {
          key: "PREVIEW_ONLY",
          value: "preview",
          isSecret: false,
          environment: "preview",
        },
      ]),
    ).toEqual({
      rows: [
        row("AUTH_SECRET", "", {
          originalKey: "AUTH_SECRET",
          preserveValue: true,
          isSecret: true,
        }),
        row("PUBLIC_SETTING", "enabled", {
          originalKey: "PUBLIC_SETTING",
          preserveValue: undefined,
          isSecret: false,
        }),
      ],
      baseline: [saved("AUTH_SECRET", ENV_MASK, true), saved("PUBLIC_SETTING", "enabled")],
    });
  });
});

describe("computeProjectEnvDiff", () => {
  it("does not write an untouched masked secret", () => {
    expect(diff([secret("AUTH_SECRET")], [saved("AUTH_SECRET", ENV_MASK, true)])).toEqual({
      upserts: [],
      deletes: [],
    });
  });

  it("upserts a typed secret replacement while preserving its classification", () => {
    expect(
      diff(
        [loaded("AUTH_SECRET", "replacement", { isSecret: true })],
        [saved("AUTH_SECRET", ENV_MASK, true)],
      ),
    ).toEqual({
      upserts: [{ key: "AUTH_SECRET", value: "replacement", isSecret: true }],
      deletes: [],
    });
  });

  it("distinguishes explicitly clearing a secret from leaving its blank display untouched", () => {
    expect(
      diff(
        [loaded("AUTH_SECRET", "", { preserveValue: false, isSecret: true })],
        [saved("AUTH_SECRET", ENV_MASK, true)],
      ),
    ).toEqual({
      upserts: [{ key: "AUTH_SECRET", value: "", isSecret: true }],
      deletes: [],
    });
  });

  it("does not rewrite unchanged plaintext", () => {
    expect(diff([loaded("PUBLIC_SETTING", "same")], [saved("PUBLIC_SETTING", "same")])).toEqual({
      upserts: [],
      deletes: [],
    });
  });

  it("renames plaintext with one upsert and one old-key delete", () => {
    expect(
      diff(
        [
          row("NEW_NAME", "value", {
            originalKey: "OLD_NAME",
            isSecret: false,
          }),
        ],
        [saved("OLD_NAME", "value")],
      ),
    ).toEqual({
      upserts: [{ key: "NEW_NAME", value: "value", isSecret: false }],
      deletes: ["OLD_NAME"],
    });
  });

  it("deletes a persisted row removed from the editor", () => {
    expect(diff([], [saved("REMOVED", "value")])).toEqual({
      upserts: [],
      deletes: ["REMOVED"],
    });
  });

  it("accepts an explicitly empty new value and ignores a completely blank row", () => {
    expect(diff([row("OPTIONAL", ""), row("", "")], [])).toEqual({
      upserts: [{ key: "OPTIONAL", value: "", isSecret: false }],
      deletes: [],
    });
  });

  it("rejects duplicate current keys", () => {
    expect(computeProjectEnvDiff([row("DUP", "one"), row(" DUP ", "two")], [])).toMatchObject({
      ok: false,
    });
  });

  it("rejects renaming a masked secret without re-entering its value", () => {
    expect(
      computeProjectEnvDiff(
        [secret("AUTH_SECRET", { key: "RENAMED" })],
        [saved("AUTH_SECRET", ENV_MASK, true)],
      ),
    ).toMatchObject({ ok: false });
  });

  it("rejects changing a masked secret's classification without re-entering its value", () => {
    expect(
      computeProjectEnvDiff(
        [secret("AUTH_SECRET", { isSecret: false })],
        [saved("AUTH_SECRET", ENV_MASK, true)],
      ),
    ).toMatchObject({ ok: false });
  });

  it("never emits the replacement key in both upserts and deletes", () => {
    expect(
      diff([row("SAME_KEY", "replacement", { isSecret: true })], [saved("SAME_KEY", "old")]),
    ).toEqual({
      upserts: [{ key: "SAME_KEY", value: "replacement", isSecret: true }],
      deletes: [],
    });
  });

  it("rejects an untracked preserved row unless its source has explicit ownership", () => {
    const rows = [row("SOURCE_VALUE", ENV_MASK, { preserveValue: true })];
    expect(computeProjectEnvDiff(rows, [])).toMatchObject({ ok: false });
    expect(computeProjectEnvDiff(rows, [], { ignoreUntrackedPreserved: true })).toEqual({
      ok: true,
      diff: { upserts: [], deletes: [] },
    });
  });
});
