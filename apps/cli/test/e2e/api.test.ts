import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/config", () => ({
  getApiUrl: () => "http://api.test",
  getToken: () => "tok",
}));

import { apiCommand } from "../../src/commands/api";
import { runCommand, stubFetch, type FetchStub } from "../helpers/harness";

let fetchStub: FetchStub;
afterEach(() => fetchStub?.restore());

describe("openship api (raw passthrough)", () => {
  it("GETs the given path under /api and pretty-prints JSON", async () => {
    fetchStub = stubFetch(() => ({ json: { hello: "world" } }));
    const { out, code } = await runCommand(apiCommand, ["/projects"]);
    expect(code).toBe(0);
    expect(fetchStub.calls[0].method).toBe("GET");
    expect(fetchStub.calls[0].url).toBe("http://api.test/api/projects");
    expect(JSON.parse(out)).toEqual({ hello: "world" });
  });

  it("defaults to POST when --data is given and forwards the raw body", async () => {
    fetchStub = stubFetch(() => ({ json: { ok: true } }));
    const { code } = await runCommand(apiCommand, ["/projects", "--data", '{"name":"x"}']);
    expect(code).toBe(0);
    expect(fetchStub.calls[0].method).toBe("POST");
    expect(fetchStub.calls[0].body).toEqual({ name: "x" });
  });

  it("builds a query string from repeatable -q key=value", async () => {
    fetchStub = stubFetch(() => ({ json: [] }));
    await runCommand(apiCommand, ["/deployments", "-q", "project=p1", "-q", "env=production"]);
    expect(fetchStub.calls[0].url).toContain("project=p1");
    expect(fetchStub.calls[0].url).toContain("env=production");
  });

  it("sets a non-zero exit code when the API responds non-2xx", async () => {
    fetchStub = stubFetch(() => ({ status: 404, json: { error: "nope" } }));
    const { code } = await runCommand(apiCommand, ["/missing"]);
    expect(code).toBe(1);
  });
});
