import { describe, it, expect } from "vitest";
import type { CommandExecutor } from "@repo/adapters";
import type { DatabaseDump } from "@repo/db";
import { readProjectSnapshot } from "./openship-manifest";

/** Minimal executor stub: `readOpenshipFile` runs `cat …` via exec — return the
 *  canned payload for that, ignore the mkdir/other calls. */
function execReturning(raw: string): CommandExecutor {
  return { exec: async () => raw } as unknown as CommandExecutor;
}

const validDump: DatabaseDump = {
  formatVersion: 1,
  exportedAt: "2026-01-01T00:00:00Z",
  sourceDriver: "pglite",
  scope: { kind: "project", projectId: "proj_abc" },
  tables: { project: [{ id: "proj_abc" }] },
};

describe("readProjectSnapshot", () => {
  it("parses a valid project-scope dump", async () => {
    const out = await readProjectSnapshot(execReturning(JSON.stringify(validDump)), "proj_abc");
    expect(out?.scope).toEqual({ kind: "project", projectId: "proj_abc" });
  });

  it("returns null for an empty/absent file", async () => {
    expect(await readProjectSnapshot(execReturning(""), "proj_abc")).toBeNull();
  });

  it("returns null for malformed JSON", async () => {
    expect(await readProjectSnapshot(execReturning("{ not json"), "proj_abc")).toBeNull();
  });

  it("returns null for a non-project-scope dump (won't restore the wrong shape)", async () => {
    const orgDump = { ...validDump, scope: { kind: "organization", organizationId: "org_1" } };
    expect(await readProjectSnapshot(execReturning(JSON.stringify(orgDump)), "proj_abc")).toBeNull();
  });

  it("returns null when tables are missing", async () => {
    const noTables = { ...validDump, tables: undefined };
    expect(await readProjectSnapshot(execReturning(JSON.stringify(noTables)), "proj_abc")).toBeNull();
  });
});
