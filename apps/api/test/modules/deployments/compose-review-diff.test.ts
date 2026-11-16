import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/platform/engine/config/env", () => ({ env: { BETTER_AUTH_SECRET: "test-review-secret" } }));
// Use the production spec normalizer and merge, without booting a database.
vi.mock("@repo/db", async () => {
  const module = await import("../../../../../packages/db/src/repos/service.repo");
  return { toComposeSpec: module.toComposeSpec, composeSpecDiff: module.composeSpecDiff };
});

import { toComposeSpec, type Service } from "@repo/db";
import type { ComposeReview } from "@repo/contracts";
import { assertComposeReviewed, composeSourceRevision, type SourceService } from "@repo/platform/engine/modules/deployments/compose-review";

function row(name: string, spec: SourceService): Service {
  return { name, kind: "compose", importedSpec: toComposeSpec(spec) } as Service;
}
function review(rows: Service[], source: SourceService[], revision?: string): ComposeReview {
  try {
    assertComposeReviewed("project", rows, source, revision);
  } catch (error) {
    return (error as { details: ComposeReview }).details;
  }
  throw new Error("Expected review gate");
}

describe("Compose review details", () => {
  it("shows changed fields, added and removed services from the import baseline", () => {
    const rows = [
      row("worker", { name: "worker", image: "worker:1", command: "node old.js" }),
      row("legacy", { name: "legacy", image: "redis:7", volumes: ["data:/data"] }),
    ];
    const source = [
      { name: "worker", image: "worker:2", command: "node new.js" },
      { name: "cache", image: "redis:8" },
    ];
    const result = review(rows, source);
    expect(result.composeChanges).toEqual({
      added: ["cache"],
      changed: ["worker"],
      removed: ["legacy"],
    });
    expect(result.composeDiff[0]!.fields).toEqual(
      expect.arrayContaining([
        { path: "image", before: "worker:1", after: "worker:2" },
        { path: "command", before: '["node","old.js"]', after: '["node","new.js"]' },
      ]),
    );
    expect(result.composeRevision).toBe(composeSourceRevision("project", source));
    expect(() =>
      assertComposeReviewed("project", rows, source, result.composeRevision),
    ).not.toThrow();
    // Review is pure, never a reconciliation or removal.
    expect(rows[0]!.importedSpec?.image).toBe("worker:1");
    expect(rows[1]!.importedSpec?.volumes).toEqual(["data:/data"]);
  });

  it("refuses an obsolete revision and one reviewed for another project", () => {
    const rows = [row("worker", { name: "worker", image: "worker:1" })];
    const source = [{ name: "worker", image: "worker:2" }];
    const first = review(rows, source);
    const newer = [{ name: "worker", image: "worker:3" }];
    expect(review(rows, newer, first.composeRevision).composeDiff[0]!.fields).toContainEqual({
      path: "image",
      before: "worker:1",
      after: "worker:3",
    });
    expect(() =>
      assertComposeReviewed("other-project", rows, source, first.composeRevision),
    ).toThrow();
  });

  it("compares secret changes before masking, without leaking values or defaults", () => {
    const old = {
      name: "worker",
      environment: { ODD_NAME: "old-private-value", REMOVED: "removed-private-value" },
      buildArgs: { CREDENTIAL: "old-build-secret" },
    };
    const next = {
      name: "worker",
      environment: { ODD_NAME: "new-private-value", ADDED: "added-private-value" },
      buildArgs: { CREDENTIAL: "new-build-secret" },
      command: "node app.js --token new-private-value",
    };
    const result = review([row("worker", old)], [next]);
    const serialized = JSON.stringify(result);
    for (const value of [
      ...Object.values(old.environment),
      ...Object.values(next.environment),
      "old-build-secret",
      "new-build-secret",
    ])
      expect(serialized).not.toContain(value);
    expect(result.composeDiff[0]!.fields).toContainEqual({
      path: "environment.ODD_NAME",
      before: "••••••••",
      after: "••••••••",
    });
    expect(result.composeDiff[0]!.fields).toContainEqual({
      path: "environment.REMOVED",
      before: "••••••••",
      after: null,
    });
  });

  it.each([
    ["--password", "private-password"],
    ["--token", "private-token"],
    ["--api-key", "private-key"],
    ["--requirepass", "private-redis-password"],
    ["--token", 'private-"quoted"-token'],
  ])("masks inline %s arguments before returning the diff", (flag, secret) => {
    const source = [{ name: "worker", commandArgv: ["worker", flag, secret] }];
    const result = review([row("worker", { name: "worker", commandArgv: ["worker"] })], source);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it.each(["-", ":-", "+", ":+", "?", ":?", ":-${OTHER:-nested}-"])("masks defaults in Compose expressions using %s", (operator) => {
    const expression = "registry/app:${TAG" + operator + "private-default}";
    const source = [{ name: "worker", image: "registry/app:private-default", advanced: {
      imageTemplate: { expression, unresolvedVariables: [] },
    } }];
    const result = review([row("worker", { name: "worker", image: "registry/app:old" })], source);
    expect(JSON.stringify(result)).not.toContain("private-default");
  });

  it("ignores interpolation values, legacy baselines and independently added services", () => {
    const source = {
      name: "worker",
      image: "worker:1",
      environment: { MODE: "old" },
      environmentTemplates: { MODE: "${MODE}" },
    };
    const rows = [
      row("worker", source),
      { name: "manual", kind: "compose", importedSpec: null } as Service,
    ];
    expect(() =>
      assertComposeReviewed("project", rows, [{ ...source, environment: { MODE: "new" } }]),
    ).not.toThrow();
  });

  it("distinguishes an inherited build argument from a removed argument", () => {
    const original = { name: "worker", buildArgs: { INHERITED: null, REMOVED: null } };
    const result = review(
      [row("worker", original)],
      [{ name: "worker", buildArgs: { INHERITED: "literal" } }],
    );
    expect(result.composeDiff[0]!.fields).toEqual(
      expect.arrayContaining([
        { path: "build.args.INHERITED", before: "null", after: "••••••••" },
        { path: "build.args.REMOVED", before: "null", after: null },
      ]),
    );
  });
});
