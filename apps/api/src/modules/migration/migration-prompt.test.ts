import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PromptPayload } from "@repo/core";
import type { MigrationServiceRoutes } from "@repo/contracts";
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
  reviewOmittedRootRoutes(
    id: string, routes: MigrationServiceRoutes,
    source: { domains: string[]; path: string; exact?: boolean }[],
    log: (message: string) => void,
  ): Promise<void>;
};

describe("migration takeover prompt lifecycle", () => {
  beforeEach(() => state.findRun.mockResolvedValue({ organizationId: "org", status: "adopting" }));

  it("proceeds without a decision when the source itself has only specific paths", async () => {
    await internals.reviewOmittedRootRoutes("path-only-run", {
      api: { domainType: "custom", customDomain: "api.onvo.me", targetPath: "/v3" },
    }, [{ domains: ["api.onvo.me"], path: "/v3" }], () => {});
    expect(migrationOrchestrator.getPendingPrompt("path-only-run")).toBeNull();
  });

  it.each(["continue", "cancel"])("holds an omitted source catch-all for the user's %s decision", async (action) => {
    const id = `omitted-root-${action}`;
    const review = internals.reviewOmittedRootRoutes(id, {
      api: { domainType: "custom", customDomain: "api.onvo.me", targetPath: "/v3" },
    }, [{ domains: ["api.onvo.me"], path: "/" }], () => {});
    const completion = action === "cancel"
      ? expect(review).rejects.toThrow("cancelled to review")
      : expect(review).resolves.toBeUndefined();
    await vi.waitFor(() => expect(migrationOrchestrator.getPendingPrompt(id)).not.toBeNull());
    const pending = migrationOrchestrator.getPendingPrompt(id)!;
    expect(pending.message).toContain("404");
    expect(pending.details?.hostnames).toEqual(["api.onvo.me"]);
    expect(await migrationOrchestrator.respondToPrompt(id, "org", pending.promptId, action)).toBe(true);
    await completion;
    expect(migrationOrchestrator.getPendingPrompt(id)).toBeNull();
  });

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
