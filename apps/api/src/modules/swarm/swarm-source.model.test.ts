import { describe, expect, it } from "vitest";
import type { SwarmStack } from "@repo/db";
import {
  assertRelativeSourcePath,
  assertSwarmStackName,
  serializeStackSource,
  validateStackSource,
} from "./swarm-source.model";

describe("Swarm stack source model", () => {
  it("preserves ordered repository compose paths and captures the immutable commit", () => {
    const source = validateStackSource({
      kind: "repository",
      composePaths: ["compose.yaml", "deploy/production.yaml"],
      sourcePath: ".",
      branch: "main",
      commitSha: "a1b2c3d4",
      expectedVersion: 3,
    });
    expect(source).toMatchObject({
      kind: "repository",
      sourcePaths: ["compose.yaml", "deploy/production.yaml"],
      sourceCommitSha: "a1b2c3d4",
      expectedVersion: 3,
    });
  });

  it("keeps inline source available only to the encrypted persistence boundary", () => {
    const yaml = "services:\n  web:\n    image: nginx:alpine\n";
    const source = validateStackSource({ kind: "inline", yaml, expectedVersion: 1 });
    expect(source.inlineYaml).toBe(yaml);
    const dto = serializeStackSource({
      sourceKind: "inline", sourcePaths: [], sourcePath: null, sourceBranch: null,
      sourceCommitSha: null, sourceVersion: 1, sourceDigest: source.sourceDigest,
      sourceYamlEnc: "enc1:not-the-plaintext", routingMode: "external",
    } as unknown as SwarmStack);
    expect(dto).toMatchObject({ kind: "inline", deployable: true, hasInlineYaml: true, routingMode: "external" });
    expect(JSON.stringify(dto)).not.toContain("nginx:alpine");
    expect(JSON.stringify(dto)).not.toContain("enc1:not-the-plaintext");
  });

  it("keeps adopted observations non-deployable and rejects unsafe names/paths", () => {
    expect(validateStackSource({ kind: "adopted", expectedVersion: 1 })).toMatchObject({
      kind: "adopted", inlineYaml: null, sourceDigest: null,
    });
    expect(() => assertSwarmStackName("Portainer Stack")).toThrow(/Stack name/);
    expect(() => assertRelativeSourcePath("../../etc/shadow", "composePaths")).toThrow(/relative path/);
    expect(() => assertRelativeSourcePath("/etc/passwd", "composePaths")).toThrow(/relative path/);
  });
});
