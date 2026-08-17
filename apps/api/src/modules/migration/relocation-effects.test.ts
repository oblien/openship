import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const { syncProjectManagedEdge, findById } = vi.hoisted(() => ({
  syncProjectManagedEdge: vi.fn(),
  findById: vi.fn(),
}));

vi.mock("@repo/db", () => ({ repos: { project: { findById } } }));
vi.mock("../projects/project-runtime.service", () => ({ syncProjectManagedEdge }));

import { applyRelocationEffects, projectRelocationEffects } from "./relocation-effects";

/**
 * Moving the containers is the visible half of a migration. The other half is everything that
 * RECORDED where the project used to live — and it was not handled at all: a moved project kept
 * its free `.opsh.io` subdomain aimed at the SOURCE server, so the URL resolved to the old machine
 * until an operator pressed "Retry routing" by hand.
 *
 * The cause is subtle and worth stating: `syncProjectManagedEdge` reads the server from the
 * project's ACTIVE deployment. Run inside the target deploy — as it was — the target deployment is
 * not active yet, so it faithfully re-pointed the subdomain at the server the project was leaving.
 */
const effects = () =>
  projectRelocationEffects({ projectId: "p1", organizationId: "org1", targetServerId: "srv_b" });

// Call counts are asserted below ("did not call the sync"), so they must not carry over.
beforeEach(() => {
  syncProjectManagedEdge.mockReset();
  findById.mockReset();
});

describe("the free-subdomain effect", () => {
  it("re-points the mapping and says so", async () => {
    findById.mockResolvedValue({ id: "p1" });
    syncProjectManagedEdge.mockResolvedValue({ ok: true, failures: [] });
    await expect(effects()[0]!.run()).resolves.toContain("re-pointed at the new server");
  });

  it("reports a failure instead of throwing — the workload is already up", async () => {
    // Failing the migration here would tear down a verified, serving stack over a record the
    // dashboard's own "Retry routing" can repair.
    findById.mockResolvedValue({ id: "p1" });
    syncProjectManagedEdge.mockResolvedValue({ ok: false, failures: ["edge unreachable"] });
    const detail = await effects()[0]!.run();
    expect(detail).toContain("still pointing at the old server");
    expect(detail).toContain("edge unreachable");
  });

  it("does nothing when the project has vanished", async () => {
    findById.mockResolvedValue(null);
    await expect(effects()[0]!.run()).resolves.toBeUndefined();
    expect(syncProjectManagedEdge).not.toHaveBeenCalled();
  });
});

describe("applyRelocationEffects", () => {
  it("logs one line per effect, naming it", async () => {
    const lines: string[] = [];
    await applyRelocationEffects(
      [{ name: "alpha", run: async () => "did a thing" }],
      (m) => lines.push(m),
    );
    expect(lines).toEqual(["alpha: did a thing"]);
  });

  it("distinguishes 'checked and clear' from silence", async () => {
    const lines: string[] = [];
    await applyRelocationEffects([{ name: "beta", run: async () => undefined }], (m) => lines.push(m));
    expect(lines[0]).toBe("beta: nothing to update");
  });

  it("keeps going after one effect throws, and never rethrows", async () => {
    // One unrepaired record must not stop the others from being repaired.
    const lines: string[] = [];
    await expect(
      applyRelocationEffects(
        [
          { name: "one", run: async () => { throw new Error("boom"); } },
          { name: "two", run: async () => "ok" },
        ],
        (m) => lines.push(m),
      ),
    ).resolves.toBeUndefined();
    expect(lines[0]).toContain("one: not updated — boom");
    expect(lines[1]).toBe("two: ok");
  });
});

describe("the orchestrator runs them at the right moment", () => {
  const orch = readFileSync(new URL("./migration.orchestrator.ts", import.meta.url), "utf8");

  it("after publishing routes, not during the deploy", () => {
    // Several effects re-point things that only exist once the routes do — and the deploy is
    // exactly where this used to run with the wrong (still-source) active deployment.
    expect(orch.indexOf("await this.publishRoutes(")).toBeLessThan(
      orch.indexOf("applyRelocationEffects("),
    );
  });

  it("only for a project move, and only cross-server", () => {
    expect(orch).toContain("if (input.projectMove && !sameServer) {");
  });
});
