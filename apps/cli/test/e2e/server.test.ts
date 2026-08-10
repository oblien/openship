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
import { setJsonMode } from "../../src/lib/output";
import { runCommand, stubFetch, type FetchStub } from "../helpers/harness";

let fetchStub: FetchStub;
beforeEach(() => {
  h.token = "tok";
});
afterEach(() => fetchStub?.restore());

const SERVERS = [
  { id: "srv1", name: "web", sshHost: "1.2.3.4", sshPort: 22, sshUser: "root" },
  { id: "srv2", name: null, sshHost: "5.6.7.8", sshPort: 22, sshUser: "deploy" },
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
  it("DELETEs the server by id", async () => {
    fetchStub = stubFetch(() => ({ status: 204 }));
    const { err, code } = await runCommand(serverCommand, ["rm", "srv1"]);
    expect(code).toBe(0);
    expect(fetchStub.calls[0].method).toBe("DELETE");
    expect(fetchStub.calls[0].url).toBe("http://api.test/api/system/servers/srv1");
    expect(err).toContain("Removed server srv1");
  });
});

describe("openship server rm --force", () => {
  it("appends ?force=true so the API skips its active-deployment guard", async () => {
    fetchStub = stubFetch(() => ({ status: 204 }));
    const { code } = await runCommand(serverCommand, ["rm", "srv1", "--force"]);
    expect(code).toBe(0);
    expect(fetchStub.calls[0].method).toBe("DELETE");
    expect(fetchStub.calls[0].url).toBe("http://api.test/api/system/servers/srv1?force=true");
  });
});

describe("openship server install (non-streaming)", () => {
  it("exits 1 when a component install fails", async () => {
    fetchStub = stubFetch((req) => {
      const component = (req.body as { component?: string })?.component;
      return component === "git"
        ? { json: { success: false, component: "git", error: "boom" } }
        : { json: { success: true, component } };
    });
    const { err, code } = await runCommand(serverCommand, ["install", "srv1", "-c", "docker", "git"]);
    expect(code).toBe(1);
    expect(err).toContain("git failed");
  });

  it("exits 0 when every component installs", async () => {
    fetchStub = stubFetch((req) => ({
      json: { success: true, component: (req.body as { component?: string })?.component },
    }));
    const { code } = await runCommand(serverCommand, ["install", "srv1", "-c", "docker"]);
    expect(code).toBe(0);
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
