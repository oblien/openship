import { Value } from "@sinclair/typebox/value";
import { ProjectDetailsSchema } from "@repo/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../src/lib/config", () => ({
  getApiUrl: () => "https://controller.example.test",
  getToken: () => "opsh_pat_fixture",
}));
import { edgeCommand } from "../../src/commands/edge";
import { setJsonMode } from "../../src/lib/output";
import { runCommand, stubFetch, type FetchStub } from "../helpers/harness";
import { domainFixture } from "../../../../packages/contracts/test/fixtures";
const projectInfo = Value.Create(ProjectDetailsSchema);
projectInfo.project.port = 3000;
projectInfo.project.options.hasServer = true;
projectInfo.project.options.workloadType = "web";
projectInfo.project.options.productionPort = "3000";

let fetchStub: FetchStub;
beforeEach(() => setJsonMode(true));
afterEach(() => {
  fetchStub?.restore();
  setJsonMode(false);
});
describe("edge commands share SDK resource operations", () => {
  it("validates a hostname before creating its optional tracking project", async () => {
    fetchStub = stubFetch(() => {
      throw new Error("Invalid host must not create a project");
    });
    expect(
      (await runCommand(edgeCommand, ["domains", "add", "not a host", "--port", "3000"])).code,
    ).toBe(1);
    expect(fetchStub.calls).toEqual([]);
  });
  it("preserves pending DNS verification as a result without turning it into a failed registration", async () => {
    const domain = domainFixture("dom_one");
    fetchStub = stubFetch((request) =>
      request.url.endsWith("/info")
        ? { json: { data: projectInfo } }
        : request.method === "PATCH"
          ? { json: { data: projectInfo.project } }
          : request.url.endsWith("/verify")
        ? {
            status: 422,
            json: {
              verified: false,
              cnameVerified: false,
              txtVerified: false,
              message: "DNS pending",
            },
          }
        : { json: { data: domain, records: { mode: "external", records: [] } } },
    );
    const result = await runCommand(edgeCommand, [
      "domains",
      "add",
      "app.example.com",
      "--project",
      "proj_one",
    ]);
    expect(result.code, result.err).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({ domain: { id: "dom_one" }, verified: false });
    expect(fetchStub.calls).toHaveLength(4);
  });
  it("deletes only the hostname found inside the selected project's authorized domain list", async () => {
    fetchStub = stubFetch(() => ({
      json: { data: [{ ...domainFixture("other"), hostname: "other.example.com" }] },
    }));
    expect(
      (
        await runCommand(edgeCommand, [
          "domains",
          "rm",
          "absent.example.com",
          "--project",
          "proj_one",
        ])
      ).code,
    ).toBe(1);
    expect(fetchStub.calls).toHaveLength(1);
    expect(fetchStub.calls[0].method).toBe("GET");
  });
  it("follows the authenticated request-log stream even in JSON mode and surfaces stream errors", async () => {
    fetchStub = stubFetch((request) =>
      request.url.endsWith("stream-token")
        ? { json: { kind: "self-hosted" } }
        : {
            headers: { "content-type": "text/event-stream" },
            text: 'event: error\ndata: {"error":"Log access lost"}\n\n',
          },
    );
    const result = await runCommand(edgeCommand, ["logs", "--project", "proj_one", "--follow"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("Log access lost");
    expect(fetchStub.calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/api/projects/proj_one/server-logs/stream-token",
      "/api/projects/proj_one/server-logs/stream",
    ]);
  });
});
