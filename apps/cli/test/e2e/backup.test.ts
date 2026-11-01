import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../../src/lib/config", () => ({ getApiUrl: () => "http://api.test", getToken: () => "token" }));
import { backupCommand } from "../../src/commands/backup";
import { setJsonMode } from "../../src/lib/output";
import { runCommand, stubFetch, type FetchStub } from "../helpers/harness";
import { backupPolicyFixture } from "../../../../packages/contracts/test/fixtures";

let fetchStub: FetchStub;
afterEach(() => { fetchStub?.restore(); setJsonMode(false); });

describe("backup commands through named SDK operations", () => {
  it("submits a validated policy and preserves caller-selected retention", async () => {
    fetchStub = stubFetch(request => {
      expect(request.url).toBe("http://api.test/api/projects/project%2Fa/backup-policies");
      expect(request.body).toMatchObject({ destinationId: "destination-a", serviceId: null, retainCount: 3 });
      return { json: { data: { ...backupPolicyFixture(), retainCount: 3 } } };
    });
    setJsonMode(true);
    const result = await runCommand(backupCommand, ["policy", "create", "--project", "project/a", "--destination", "destination-a", "--retain-count", "3"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({ retainCount: 3 });
    expect(fetchStub.calls).toHaveLength(1);
  });

  it("stops following preparation at prepared and closes the stream", async () => {
    const cancelled = vi.fn();
    fetchStub = stubFetch(request => request.method === "POST"
      ? { json: { data: { restoreId: "restore-a", confirmationToken: "confirmation-token" } } }
      : new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('event: snapshot\ndata: {"type":"snapshot","restore":{"status":"preparing"}}\n\nevent: transition\ndata: {"type":"transition","status":"prepared"}\n\n'));
        }, cancel: cancelled,
      }), { headers: { "Content-Type": "text/event-stream" } }));
    setJsonMode(true);
    const result = await runCommand(backupCommand, ["run", "restore", "run-a", "--follow"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain('"prepared"');
    expect(cancelled).toHaveBeenCalledOnce();
    expect(fetchStub.calls.map(call => call.url)).toEqual([
      "http://api.test/api/backup-runs/run-a/restore/prepare", "http://api.test/api/backup-restores/restore-a/stream",
    ]);
  });

  it("reports a pending destructive cancellation without claiming the worker stopped", async () => {
    const data = { ok: true, accepted: true, status: "applying", destructive: true, forced: false };
    fetchStub = stubFetch(() => ({ json: { data } }));
    setJsonMode(true);
    const result = await runCommand(backupCommand, ["restore", "cancel", "restore-a"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toEqual(data);
    expect(result.err).toBe("");
  });
});
