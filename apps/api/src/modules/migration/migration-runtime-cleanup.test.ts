import { expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  source: { stop: vi.fn(), dispose: vi.fn(async () => {}) },
  createRuntime: vi.fn(),
}));

vi.mock("@repo/platform/engine/modules/migration/migration-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/platform/engine/modules/migration/migration-runtime")>()),
  createMigrationDockerRuntime: h.createRuntime,
}));

vi.mock("@repo/platform/engine/modules/migration/migration-access", () => ({ assertMigrationEndpoints: async () => ({ source: {}, target: {} }) }));

import { migrationOrchestrator } from "@repo/platform/engine/modules/migration/migration.orchestrator";

it("releases the migration source if opening the target fails, before stopping any service", async () => {
  h.createRuntime.mockResolvedValueOnce(h.source).mockRejectedValueOnce(new Error("target unreachable"));
  // Exercise the real transfer boundary; only the two remote runtimes are replaced.
  const move = migrationOrchestrator as unknown as {
    moveData: (...args: unknown[]) => Promise<unknown>;
  };
  await expect(move.moveData(
    "project", "source", "target", "org", { web: "source-container" }, false,
    {}, [], [], {}, {}, () => {},
  )).rejects.toThrow("target unreachable");
  expect(h.createRuntime.mock.calls).toEqual([["source", "org"], ["target", "org"]]);
  expect(h.source.dispose).toHaveBeenCalledTimes(1);
  expect(h.source.stop).not.toHaveBeenCalled();
});
