import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/config", () => ({
  getApiUrl: () => "http://api.test",
  getToken: () => "tok",
}));
vi.mock("../../src/lib/caps", () => ({
  fetchCaps: async () => ({ selfHosted: true }),
  requireSelfHost: () => {},
}));

import { projectCommand } from "../../src/commands/project";
import { runCommand, stubFetch, type FetchStub } from "../helpers/harness";

let fetchStub: FetchStub;
afterEach(() => fetchStub?.restore());

describe("openship project list", () => {
  it("paginates /projects and tabulates the rows", async () => {
    fetchStub = stubFetch((req) => {
      expect(req.url).toContain("/api/projects");
      return { json: { data: [{ id: "p1", name: "shop", slug: "shop" }], total: 1 } };
    });
    const { out, code } = await runCommand(projectCommand, ["list"]);
    expect(code).toBe(0);
    expect(out).toContain("p1");
    expect(out).toContain("shop");
  });
});

describe("openship project get", () => {
  it("GETs /projects/:id", async () => {
    fetchStub = stubFetch(() => ({ json: { data: { id: "p1", name: "shop" } } }));
    const { out, code } = await runCommand(projectCommand, ["get", "p1"]);
    expect(code).toBe(0);
    expect(fetchStub.calls[0].url).toContain("/api/projects/p1");
    expect(out).toContain("shop");
  });
});
