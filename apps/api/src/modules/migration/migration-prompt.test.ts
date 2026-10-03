import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PromptPayload } from "@repo/core";
const state = vi.hoisted(() => ({ findRun: vi.fn() }));
vi.mock("@repo/db", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  repos: { dockerMigrationRun: { findById: state.findRun, requestCancel: async () => true } },
}));
import { migrationOrchestrator } from "@repo/platform/engine/modules/migration/migration.orchestrator";

const prompt: PromptPayload = {
  promptId: "edge_conflict",
  title: "Existing reverse proxy detected",
  message: "Review existing sites",
  actions: [
    { id: "migrate", label: "Migrate sites" },
    { id: "cancel", label: "Cancel" },
  ],
};
const internals = migrationOrchestrator as unknown as {
  promptUser(id: string, prompt: PromptPayload): Promise<string>;
};

describe("migration takeover prompt lifecycle", () => {
  beforeEach(() => state.findRun.mockResolvedValue({ organizationId: "org", status: "adopting" }));

  it("replays the pending prompt and accepts only its current action in the owning organization", async () => {
    const answer = internals.promptUser("prompt-run", prompt);
    await vi.waitFor(() => expect(migrationOrchestrator.getPendingPrompt("prompt-run")).not.toBeNull());
    const pending = migrationOrchestrator.getPendingPrompt("prompt-run")!;
    expect(pending.expiresAt).toBeDefined();
    expect(
      await migrationOrchestrator.respondToPrompt(
        "prompt-run",
        "other-org",
        pending.promptId,
        "migrate",
      ),
    ).toBe(false);
    expect(
      await migrationOrchestrator.respondToPrompt(
        "prompt-run",
        "org",
        pending.promptId,
        "override",
      ),
    ).toBe(false);
    expect(
      await migrationOrchestrator.respondToPrompt("prompt-run", "org", "stale", "migrate"),
    ).toBe(false);
    expect(migrationOrchestrator.getPendingPrompt("prompt-run")).toEqual(pending);
    expect(
      await migrationOrchestrator.respondToPrompt("prompt-run", "org", pending.promptId, "migrate"),
    ).toBe(true);
    await expect(answer).resolves.toBe("migrate");
    expect(migrationOrchestrator.getPendingPrompt("prompt-run")).toBeNull();
  });

  it("rejects a cancelled run's waiter immediately and removes the prompt", async () => {
    const answer = internals.promptUser("cancel-run", prompt);
    const rejection = expect(answer).rejects.toThrow("Migration cancelled");
    await vi.waitFor(() => expect(migrationOrchestrator.getPendingPrompt("cancel-run")).not.toBeNull());
    await expect(migrationOrchestrator.cancel("cancel-run", "org")).resolves.toEqual({ ok: true });
    await rejection;
    expect(migrationOrchestrator.getPendingPrompt("cancel-run")).toBeNull();
  });
});
