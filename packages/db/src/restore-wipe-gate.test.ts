import { describe, it, expect, vi, afterEach } from "vitest";

// GATE 2 (engine last-resort): restoreSubgraph must refuse a wipe restore on a
// multi-tenant (CLOUD_MODE) instance — a whole-instance TRUNCATE would wipe every
// tenant. The guard fires at the top of the wipe branch (inside the transaction,
// before any TRUNCATE), so a fake tx whose execute() no-ops reaches it.
const fakeTx = { execute: vi.fn(async () => []) };
vi.mock("./client", () => ({
  db: { transaction: (cb: (tx: unknown) => Promise<void>) => cb(fakeTx) },
  getDriver: () => "pglite" as const,
}));

import { restoreSubgraph, DUMP_FORMAT_VERSION } from "./dump";

const instanceWipeDump = {
  formatVersion: DUMP_FORMAT_VERSION,
  sourceDriver: "pglite" as const,
  scope: { kind: "instance" as const },
  tables: {},
};

describe("restoreSubgraph wipe gate (GATE 2)", () => {
  const prev = process.env.CLOUD_MODE;
  afterEach(() => {
    if (prev === undefined) delete process.env.CLOUD_MODE;
    else process.env.CLOUD_MODE = prev;
  });

  it("refuses a wipe restore when CLOUD_MODE=true", async () => {
    process.env.CLOUD_MODE = "true";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(restoreSubgraph(instanceWipeDump as any, { mode: "wipe" })).rejects.toThrow(
      /multi-tenant/i,
    );
  });
});
