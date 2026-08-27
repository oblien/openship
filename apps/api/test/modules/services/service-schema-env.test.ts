import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { ENV_MASK } from "@repo/core";
import {
  CreateServiceBody,
  SetServiceEnvVarsBody,
  SyncServicesBody,
  UpdateServiceBody,
} from "../../../src/modules/services/service.schema";

/**
 * `environment` is nullable on UPDATE only (#619), and that asymmetry is load-bearing
 * rather than incidental: on a partial patch, absent means "keep", so a delete needs
 * its own spelling — while create and compose sync each rebuild the whole map from an
 * upstream spec, where a null key would just be a second way to write "absent".
 *
 * Both halves are pinned here because both are easy to break by accident. Spreading
 * the nullable field into `ComposeFieldsBlock` (the obvious "dedupe") would silently
 * teach create and sync to accept nulls that `unmaskEnv` writes straight through as
 * dropped keys. And the update override is only in effect because it is declared
 * AFTER the spread — reordering the object literal reverts it with no other symptom.
 */

const checkUpdate = (env: unknown) => Value.Check(UpdateServiceBody, { environment: env });
const checkCreate = (env: unknown) => Value.Check(CreateServiceBody, { name: "db", environment: env });
const checkSync = (env: unknown) =>
  Value.Check(SyncServicesBody, { services: [{ name: "db", environment: env }] });

describe("UpdateServiceBody.environment", () => {
  it("accepts a per-key null (remove that variable) and a null map (clear everything)", () => {
    expect(checkUpdate({ KEEP: "1", DROP: null })).toBe(true);
    expect(checkUpdate(null)).toBe(true);
  });

  it("accepts plain strings, the mask sentinel, and an empty map", () => {
    expect(checkUpdate({ NODE_ENV: "production" })).toBe(true);
    expect(checkUpdate({ API_TOKEN: ENV_MASK })).toBe(true);
    expect(checkUpdate({})).toBe(true);
  });

  it("still rejects a non-string, non-null value", () => {
    expect(checkUpdate({ PORT: 8080 })).toBe(false);
    expect(checkUpdate({ NESTED: { a: 1 } })).toBe(false);
  });

  // The cap on the sibling env surfaces is 10000, but applying it here alone would
  // make a long value (CA chain, base64 kubeconfig) creatable via POST or /sync and
  // then permanently un-PATCH-able. Update stays as unbounded as they are.
  it("does not cap value length more tightly than create and sync do", () => {
    const long = "x".repeat(20_000);
    expect(checkUpdate({ BUNDLE: long })).toBe(true);
    expect(checkCreate({ BUNDLE: long })).toBe(true);
  });
});

describe("create and sync stay non-nullable", () => {
  it("CreateServiceBody rejects a null env value and a null map", () => {
    expect(checkCreate({ DROP: null })).toBe(false);
    expect(checkCreate(null)).toBe(false);
    expect(checkCreate({ NODE_ENV: "production" })).toBe(true);
  });

  it("SyncServicesBody rejects a null env value and a null map", () => {
    expect(checkSync({ DROP: null })).toBe(false);
    expect(checkSync(null)).toBe(false);
    expect(checkSync({ NODE_ENV: "production" })).toBe(true);
  });
});

describe("SetServiceEnvVarsBody masked-row identity", () => {
  it("accepts the source row id used to rename an unrevealed secret", () => {
    expect(Value.Check(SetServiceEnvVarsBody, {
      environment: "production",
      vars: [{ sourceId: "env_1", key: "RENAMED_TOKEN", value: ENV_MASK, isSecret: true }],
    })).toBe(true);
  });
});
