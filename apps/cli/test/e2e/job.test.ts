import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job, JobRun } from "@repo/sdk";

vi.mock("../../src/lib/config", () => ({ getApiUrl: () => "http://api.test", getToken: () => "tok" }));
import { runCommand, stubFetch, type FetchStub } from "../helpers/harness";

const job: Job = {
  id: "1", key: "custom:1", kind: "custom", label: "sync", cronExpression: null,
  scheduleType: "manual", runAt: null, enabled: true, actionType: "command",
  actionConfig: { command: "true" }, dependsOn: null, triggerEvents: null, notifyConfig: null,
  createdBy: null, createdAt: "2026-09-15T00:00:00Z", updatedAt: "2026-09-15T00:00:00Z",
  nextRunAt: null, lastRun: null, recentRuns: [],
};
const jobRun: JobRun = {
  id: "r1", jobId: "1", kind: "custom", trigger: "manual", status: "success", serverId: "s1",
  attempt: 1, startedAt: "2026-09-15T00:00:00Z", finishedAt: "2026-09-15T00:00:01Z",
  durationMs: 1000, summary: null, output: "saved output", error: null, createdAt: "2026-09-15T00:00:00Z",
};

let command: typeof import("../../src/commands/job").jobCommand;
let fetchStub: FetchStub;
let dir: string;
beforeEach(async () => {
  vi.resetModules();
  command = (await import("../../src/commands/job")).jobCommand;
  (await import("../../src/lib/output")).setJsonMode(false);
  dir = mkdtempSync(join(tmpdir(), "openship-job-test-"));
});
afterEach(() => { fetchStub?.restore(); rmSync(dir, { recursive: true, force: true }); });

describe("openship job", () => {
  it.each([false, true])("lists authenticated jobs with JSON mode %s", async (json) => {
    (await import("../../src/lib/output")).setJsonMode(json);
    const rows = [job];
    fetchStub = stubFetch(() => ({ json: { data: rows } }));
    const { out, code } = await runCommand(command, ["list"]);
    expect(code).toBe(0);
    if (json) expect(JSON.parse(out)).toEqual(rows);
    else { expect(out).toContain("custom:1"); expect(out).toContain("sync"); }
    expect(fetchStub.calls[0].url).toBe("http://api.test/api/jobs");
    expect(fetchStub.calls[0].headers.authorization).toBe("Bearer tok");
  });
  it("encodes keys and unwraps details", async () => {
    fetchStub = stubFetch(() => ({ json: { data: { ...job, key: "custom:a/b" } } }));
    const { out } = await runCommand(command, ["get", "custom:a/b"]);
    expect(fetchStub.calls[0].url).toBe("http://api.test/api/jobs/custom%3Aa%2Fb");
    expect(JSON.parse(out)).toEqual({ ...job, key: "custom:a/b" });
  });
  it("creates a recurring job with only supplied fields", async () => {
    fetchStub = stubFetch(() => ({ status: 201, json: { data: job } }));
    const { code } = await runCommand(command, ["create", "--name", "sync", "--server", "s1", "--command", "npm test", "--cron", "17 4 * * 1"]);
    expect(code).toBe(0);
    expect(fetchStub.calls[0].method).toBe("POST");
    expect(fetchStub.calls[0].url).toBe("http://api.test/api/jobs");
    expect(fetchStub.calls[0].body).toEqual({ label: "sync", serverIds: ["s1"], command: "npm test", cronExpression: "17 4 * * 1" });
  });
  it.each(["manual", "once"])("passes the %s schedule without a cron", async (schedule) => {
    fetchStub = stubFetch(() => ({ json: { data: job } }));
    const args = ["create", "--name", "sync", "--server", "s1", "--command", "true", "--schedule", schedule];
    if (schedule === "once") args.push("--at", "2026-10-01T04:00:00Z");
    expect((await runCommand(command, args)).code).toBe(0);
    const body = fetchStub.calls[0].body as Record<string, unknown>;
    expect(body.scheduleType).toBe(schedule);
    expect(body.cronExpression).toBeUndefined();
    expect(body.runAt).toBe(schedule === "once" ? "2026-10-01T04:00:00Z" : undefined);
  });
  it("loads advanced settings from a file with flag precedence", async () => {
    const file = join(dir, "job.json");
    const config = { label: "old", command: "true", serverIds: ["s1", "s2"], env: { MODE: "ci" }, secrets: { TOKEN: "private" }, retry: { maxAttempts: 2, backoffSeconds: 5 } };
    writeFileSync(file, JSON.stringify(config));
    fetchStub = stubFetch(() => ({ json: { data: job } }));
    const { out, err, code } = await runCommand(command, ["create", "--file", file, "--name", "new", "--server", "s3"]);
    expect(code).toBe(0);
    expect(fetchStub.calls[0].body).toEqual({ ...config, label: "new", serverIds: ["s3"] });
    expect(out + err).not.toContain("private");
  });
  it("rejects malformed JSON before requesting", async () => {
    const file = join(dir, "bad.json"); writeFileSync(file, "{");
    fetchStub = stubFetch(() => ({ json: {} }));
    expect((await runCommand(command, ["create", "--file", file])).code).toBe(1);
    expect(fetchStub.calls).toHaveLength(0);
  });
  it.each([
    { flags: ["--cron", "0 1 * * *"], body: { cronExpression: "0 1 * * *" } },
    { flags: ["--enabled"], body: { enabled: true } },
    { flags: ["--no-enabled"], body: { enabled: false } },
  ])("patches only explicit fields $flags", async ({ flags, body }) => {
    fetchStub = stubFetch(() => ({ json: { data: job } }));
    expect((await runCommand(command, ["update", "custom:1", ...flags])).code).toBe(0);
    expect(fetchStub.calls[0]).toMatchObject({ method: "PATCH", url: "http://api.test/api/jobs/custom%3A1" });
    expect(fetchStub.calls[0].body).toEqual(body);
  });
  it("deletes with confirmation and returns JSON", async () => {
    (await import("../../src/lib/output")).setJsonMode(true);
    fetchStub = stubFetch(() => ({ json: { success: true } }));
    const { code, out } = await runCommand(command, ["delete", "custom:1", "--yes"]);
    expect(code).toBe(0); expect(JSON.parse(out)).toEqual({ success: true });
    expect(fetchStub.calls[0]).toMatchObject({ method: "DELETE", url: "http://api.test/api/jobs/custom%3A1" });
  });
  it("requires --yes before deleting", async () => {
    fetchStub = stubFetch(() => ({ json: {} }));
    expect((await runCommand(command, ["delete", "custom:1"])).code).toBe(1);
    expect(fetchStub.calls).toHaveLength(0);
  });
  it.each([
    { key: "custom:1", runId: "r1" },
    { key: "system:1", summary: { pruned: 2 } },
  ])("returns run acceptance or a built-in summary $key", async (data) => {
    fetchStub = stubFetch(() => ({ json: { data } }));
    const args = ["run", data.key];
    if (data.summary) args.push("--follow");
    const { out, code } = await runCommand(command, args);
    expect(code).toBe(0); expect(JSON.parse(out)).toEqual(data);
    expect(fetchStub.calls).toHaveLength(1);
    expect(fetchStub.calls[0]).toMatchObject({ method: "POST", url: `http://api.test/api/jobs/${encodeURIComponent(data.key)}/run` });
  });
  it("lists history with a limit", async () => {
    fetchStub = stubFetch(() => ({ json: { data: [jobRun] } }));
    const { out, code } = await runCommand(command, ["runs", "custom:1", "--limit", "5"]);
    expect(code).toBe(0); expect(out).toContain("success");
    expect(fetchStub.calls[0].url).toBe("http://api.test/api/jobs/custom%3A1/runs?limit=5");
  });
  it.each([false, true])("reads stored logs with JSON mode %s", async (json) => {
    (await import("../../src/lib/output")).setJsonMode(json);
    const run = { ...jobRun, id: "r/1" };
    fetchStub = stubFetch(() => ({ json: { data: run } }));
    const { out, code } = await runCommand(command, ["logs", "r/1"]);
    expect(code).toBe(0);
    expect(json ? JSON.parse(out) : out.trim()).toEqual(json ? run : "saved output");
    expect(fetchStub.calls[0].url).toBe("http://api.test/api/jobs/runs/r%2F1");
  });
  it.each(["success", "failed"])("follows snapshots, live logs, and %s completion", async (status) => {
    const events = [{ type: "snapshot", run: { output: "previous" } }, { type: "log", line: "live" }, { type: "complete", status, error: status === "failed" ? "exit 1" : undefined }];
    fetchStub = stubFetch((req) => req.method === "POST"
      ? { json: { data: { key: "custom:1", runId: "r1" } } }
      : { text: events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") });
    const { out, err, code } = await runCommand(command, ["run", "custom:1", "--follow"]);
    expect(code).toBe(status === "success" ? 0 : 1);
    expect(out).toContain("previous"); expect(out).toContain("live");
    if (status === "failed") expect(err).toContain("exit 1");
    expect(fetchStub.calls[1].url).toBe("http://api.test/api/jobs/runs/r1/stream");
  });
  it("streams structured completion events for finished runs", async () => {
    (await import("../../src/lib/output")).setJsonMode(true);
    const event = { type: "complete", status: "success" };
    fetchStub = stubFetch(() => ({ text: `data: ${JSON.stringify(event)}\n\n` }));
    const { out, code } = await runCommand(command, ["logs", "r1", "--follow"]);
    expect(code).toBe(0); expect(JSON.parse(out)).toEqual(event);
  });
  it("fails if the stream closes before completion", async () => {
    fetchStub = stubFetch(() => ({ text: 'data: {"type":"log","line":"partial"}\n\n' }));
    const { code, err } = await runCommand(command, ["logs", "r1", "--follow"]);
    expect(code).toBe(1); expect(err).toContain("before completion");
  });
  it.each([403, 404, 500])("reports API errors with a nonzero exit (%s)", async (status) => {
    fetchStub = stubFetch(() => ({ status, json: { error: "Job unavailable" } }));
    const { code, err } = await runCommand(command, ["get", "custom:1"]);
    expect(code).toBe(1); expect(err).toContain("Job unavailable");
  });
});
