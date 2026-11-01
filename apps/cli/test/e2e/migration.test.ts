import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../src/lib/config", () => ({
  getApiUrl: () => "https://controller.example.test",
  getToken: () => "opsh_pat_fixture",
}));
import { migrationCommand } from "../../src/commands/migration";
import { setJsonMode } from "../../src/lib/output";
import { runCommand, stubFetch, type FetchStub } from "../helpers/harness";
let fetchStub: FetchStub;
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "openship-migration-cli-"));
  setJsonMode(true);
});
afterEach(() => {
  fetchStub?.restore();
  setJsonMode(false);
  rmSync(directory, { recursive: true, force: true });
});

describe("migration CLI safety and recovery", () => {
  it("requires confirmation to start a move and preserves the supplied container IDs", async () => {
    const input = {
      projectName: "orders",
      sourceServerId: "srv_old",
      targetServerId: "srv_cloud",
      serviceNames: ["api"],
      serviceContainerIds: ["exact-container"],
    };
    const file = join(directory, "move.json");
    writeFileSync(file, JSON.stringify(input));
    fetchStub = stubFetch(() => ({
      json: { success: true, migrationId: "mig_one", confirmationToken: "review-token" },
    }));
    expect((await runCommand(migrationCommand, ["start", file])).code).toBe(1);
    expect(fetchStub.calls).toEqual([]);
    expect((await runCommand(migrationCommand, ["start", file, "--yes"])).code).toBe(0);
    expect(fetchStub.calls[0].body).toEqual(input);
    expect(fetchStub.calls).toHaveLength(1);
  });
  it("requires an explicit cutover choice and never escalates retention to destruction on error", async () => {
    const tokenFile = join(directory, "token");
    writeFileSync(tokenFile, "review-token", { mode: 0o600 });
    fetchStub = stubFetch(() => ({ status: 409, json: { error: "Cutover token invalid" } }));
    expect(
      (
        await runCommand(migrationCommand, [
          "cutover",
          "mig_one",
          "--token-file",
          tokenFile,
          "--originals",
          "retain",
        ])
      ).code,
    ).toBe(1);
    expect(fetchStub.calls).toEqual([]);
    const result = await runCommand(migrationCommand, [
      "cutover",
      "mig_one",
      "--token-file",
      tokenFile,
      "--originals",
      "retain",
      "--yes",
    ]);
    expect(result.code).toBe(1);
    expect(fetchStub.calls).toHaveLength(1);
    expect(fetchStub.calls[0].body).toEqual({ confirmationToken: "review-token", kill: false });
    expect(result.out + result.err).not.toContain("review-token");
  });
  it("does not confuse scan progress with a completed scan", async () => {
    fetchStub = stubFetch(() => ({
      text: 'event: progress\ndata: {"type":"progress","message":"Inspecting Docker"}\n\n',
      headers: { "content-type": "text/event-stream" },
    }));
    const result = await runCommand(migrationCommand, ["scan", "srv_one", "--follow"]);
    expect(result.code).toBe(1);
    expect(fetchStub.calls).toHaveLength(1);
    expect(fetchStub.calls[0].method).toBe("GET");
  });
  it.each(["failed", "rolled_back", "succeeded"])(
    "reports a reattached %s run accurately without restarting it",
    async (status) => {
      fetchStub = stubFetch(() => ({
        text: `event: complete\ndata: ${JSON.stringify({ type: "complete", status })}\n\n`,
        headers: { "content-type": "text/event-stream" },
      }));
      const result = await runCommand(migrationCommand, ["events", "mig_existing"]);
      expect(result.code, result.err).toBe(status === "succeeded" ? 0 : 1);
      expect(fetchStub.calls).toHaveLength(1);
      expect(fetchStub.calls[0].method).toBe("GET");
      expect(JSON.parse(result.out).data.status).toBe(status);
    },
  );
  it("prints input schemas offline, including transfer and cutover safeguards", async () => {
    fetchStub = stubFetch(() => {
      throw new Error("No requests expected");
    });
    const result = await runCommand(migrationCommand, ["start", "--schema"]);
    expect(result.code, result.err).toBe(0);
    expect(JSON.parse(result.out).properties.killOriginals.description).toContain(
      "explicit cutover",
    );
    expect(fetchStub.calls).toEqual([]);
  });
});
