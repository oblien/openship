import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../../src/lib/config", () => ({ getApiUrl: () => "http://api.test", getToken: () => "token" }));
import { backupCommand } from "../../src/commands/backup";
import { setJsonMode } from "../../src/lib/output";
import { runCommand, stubFetch, type FetchStub } from "../helpers/harness";
import { backupDestinationFixture } from "../../../../packages/contracts/test/fixtures";

let fetchStub: FetchStub;
afterEach(() => { fetchStub?.restore(); setJsonMode(false); });

describe("backup destination commands through the SDK", () => {
  it("uses a direct destination grant without a collection read", async () => {
    const destination = backupDestinationFixture("destination/a");
    fetchStub = stubFetch(request => {
      expect(request.url).toBe("http://api.test/api/backup-destinations/destination%2Fa");
      return { json: { data: destination } };
    });
    setJsonMode(true);
    const result = await runCommand(backupCommand, ["destination", "get", destination.id]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toEqual(destination);
    expect(fetchStub.calls).toHaveLength(1);
  });
  it("reports failed preflight with a nonzero status even in JSON mode", async () => {
    fetchStub = stubFetch(() => ({ json: { data: { ok: false, reason: "Destination unavailable" } } }));
    setJsonMode(true);
    const result = await runCommand(backupCommand, ["destination", "preflight", "destination-a"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toEqual({ ok: false, reason: "Destination unavailable" });
    expect(result.err).not.toContain("Command exited");
  });
});
