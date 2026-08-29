import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("failed deployment domain cleanup (#675)", () => {
  it("tracks only authoritatively-created, non-custom domains for rollback", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "../../../src/modules/deployments/build-pipeline.ts"),
      "utf8",
    );

    expect(source).toContain(
      'if (ensured.created && domainRecord && domainRecord.domainType !== "custom")',
    );
    expect(source).not.toContain(
      "!projectDomains.some((d) => d.id === created.id)",
    );
  });
});
