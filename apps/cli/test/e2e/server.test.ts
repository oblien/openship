import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ token: "tok" as string | null }));
vi.mock("../../src/lib/config", () => ({
  getApiUrl: () => "http://api.test",
  getToken: () => h.token,
}));
vi.mock("../../src/lib/caps", () => ({
  fetchCaps: async () => ({ selfHosted: true }),
  requireSelfHost: () => {},
}));

import { serverCommand } from "../../src/commands/server";
import { serverFixture } from "../../../../packages/contracts/test/fixtures";
import { setJsonMode } from "../../src/lib/output";
import { runCommand, stubFetch, type FetchStub } from "../helpers/harness";

let fetchStub: FetchStub;
beforeEach(() => {
  h.token = "tok";
});
afterEach(() => { fetchStub?.restore(); setJsonMode(false); });

const SERVERS = [
  { ...serverFixture("srv1"), name: "web", sshHost: "1.2.3.4", sshPort: 22, sshUser: "root" },
  { ...serverFixture("srv2"), name: null, sshHost: "5.6.7.8", sshPort: 22, sshUser: "deploy" },
];

describe("openship server list", () => {
  it("GETs /system/servers and tabulates them", async () => {
    fetchStub = stubFetch(() => ({ json: SERVERS }));
    const { out, code } = await runCommand(serverCommand, ["list"]);
    expect(code).toBe(0);
    expect(fetchStub.calls[0].url).toBe("http://api.test/api/system/servers");
    expect(fetchStub.calls[0].method).toBe("GET");
    expect(out).toContain("srv1");
    expect(out).toContain("1.2.3.4");
  });

  it("emits raw JSON in json mode (the root --json flag sets this)", async () => {
    setJsonMode(true);
    fetchStub = stubFetch(() => ({ json: SERVERS }));
    try {
      const { out } = await runCommand(serverCommand, ["list"]);
      expect(JSON.parse(out)).toEqual(SERVERS);
    } finally {
      setJsonMode(false);
    }
  });
});

describe("openship server rm", () => {
  it("reports a kept server and exits unsuccessfully when workload cleanup fails", async () => {
    fetchStub = stubFetch(() => ({ status: 409, json: {
      ok: false, serverRemoved: false, code: "SERVER_WORKLOAD_TEARDOWN_FAILED", error: "workload still running",
      destroyOnSource: false, workloads: [{ id: "p1", name: "app", ok: false, error: "workload still running" }],
    } }));
    const { err, code } = await runCommand(serverCommand, ["rm", "srv1"]);
    expect(code).toBe(1);
    expect(err).toContain("workload still running");
    expect(err).not.toContain("Removed server");
  });
  it("DELETEs the server by id", async () => {
    fetchStub = stubFetch(() => ({ json: { ok: true, serverRemoved: true, destroyOnSource: false, workloads: [], removed: 0 } }));
    const { err, code } = await runCommand(serverCommand, ["rm", "srv1"]);
    expect(code).toBe(0);
    expect(fetchStub.calls[0].method).toBe("DELETE");
    expect(fetchStub.calls[0].url).toBe("http://api.test/api/system/servers/srv1");
    expect(err).toContain("Removed server srv1");
  });
});

describe("guard: not logged in", () => {
  it("exits 1 with a login hint and makes no request", async () => {
    h.token = null;
    fetchStub = stubFetch(() => ({ json: [] }));
    const { err, code } = await runCommand(serverCommand, ["list"]);
    expect(code).toBe(1);
    expect(err).toContain("Not logged in");
    expect(fetchStub.calls).toHaveLength(0);
  });
});

describe("guard: API error", () => {
  it("surfaces the API {error} message and exits 1", async () => {
    fetchStub = stubFetch(() => ({ status: 500, json: { error: "db down" } }));
    const { err, code } = await runCommand(serverCommand, ["list"]);
    expect(code).toBe(1);
    expect(err).toContain("db down");
  });
});

describe("server installation outcomes", () => {
  it("returns a failing exit code for a failed connection test in JSON mode", async () => {
    setJsonMode(true);
    fetchStub = stubFetch(() => ({ status: 400, json: { ok: false, code: "auth_failed", message: "Authentication failed" } }));
    const { code, out } = await runCommand(serverCommand, ["test", "--host", "example.test", "--password", "secret"]);
    expect(code).toBe(1);
    expect(JSON.parse(out)).toMatchObject({ ok: false, code: "auth_failed" });
    expect(fetchStub.calls[0]).toMatchObject({ method: "POST", body: { sshHost: "example.test", sshPassword: "secret" } });
  });

  it.each([false, true])("reports failed streamed installs in JSON mode=%s", async json => {
    setJsonMode(json);
    fetchStub = stubFetch(() => ({ text: 'event: complete\ndata: {"status":"failed"}\n\nevent: end\ndata: {"status":"failed"}\n\n', headers: { "Content-Type": "text/event-stream" } }));
    const { code, err } = await runCommand(serverCommand, ["install", "srv1", "-c", "edge", "--follow"]);
    expect(code).toBe(1);
    expect(err).not.toContain("Install finished");
    expect(fetchStub.calls[0]).toMatchObject({ method: "POST", body: { serverId: "srv1", components: ["edge"] } });
  });

  it("refuses to report success when an install stream ends without an outcome", async () => {
    fetchStub = stubFetch(() => ({ text: 'event: log\ndata: {"component":"edge","message":"Pulling"}\n\n', headers: { "Content-Type": "text/event-stream" } }));
    const { code, err } = await runCommand(serverCommand, ["install", "srv1", "-c", "edge", "--follow"]);
    expect(code).toBe(1);
    expect(err).toContain("before an outcome");
  });

  it("returns failure for a structured single-component installation failure", async () => {
    setJsonMode(true);
    fetchStub = stubFetch(() => ({ json: { component: "edge", success: false, error: "image unavailable" } }));
    const { code, out } = await runCommand(serverCommand, ["install", "srv1", "-c", "edge"]);
    expect(code).toBe(1);
    expect(JSON.parse(out)).toEqual([expect.objectContaining({ success: false })]);
  });

  it("sends an explicit prompt response through the named server SDK method", async () => {
    fetchStub = stubFetch(() => ({ json: { ok: true } }));
    const { code } = await runCommand(serverCommand, ["install-respond", "setup-1", "--action", "cancel"]);
    expect(code).toBe(0);
    expect(fetchStub.calls[0]).toMatchObject({ url: "http://api.test/api/system/install/respond", method: "POST", body: { sessionId: "setup-1", action: "cancel" } });
  });
});
