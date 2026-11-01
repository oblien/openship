import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
vi.mock("../../src/lib/config", () => ({ getApiUrl: () => "http://api.test", getToken: () => "token" }));
import { appCommand } from "../../src/commands/app";
import { runCommand, stubFetch, type FetchStub } from "../helpers/harness";

let fetchStub: FetchStub;
const directories: string[] = [];
afterEach(async () => {
  fetchStub?.restore();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
async function file(value: unknown) {
  const directory = await mkdtemp(join(tmpdir(), "openship-app-command-"));
  directories.push(directory);
  const path = join(directory, "input.json");
  await writeFile(path, JSON.stringify(value));
  return path;
}

describe("app commands through the SDK", () => {
  it("passes install choices to the existing app installer without submitting a deployment", async () => {
    const config = await file({ PASSWORD: "chosen-secret" });
    const routes = await file([{ service: "app", port: 80, mode: "port" }]);
    fetchStub = stubFetch(request => {
      expect(request.method).toBe("POST");
      expect(request.url).toBe("http://api.test/api/apps");
      expect(request.body).toEqual({ templateId: "custom-app", name: "Customer", config: { PASSWORD: "chosen-secret" }, routes: [{ service: "app", port: 80, mode: "port" }] });
      return { json: { data: { kind: "template", projectId: "project-a", slug: "customer" } } };
    });
    const result = await runCommand(appCommand, ["install", "custom-app", "--name", "Customer", "--config", config, "--routes", routes]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toEqual({ kind: "template", projectId: "project-a", slug: "customer" });
    expect(result.out + result.err).not.toContain("chosen-secret");
    expect(fetchStub.calls).toHaveLength(1);
  });
  it("uses the curated settings patch so blank secrets retain their server-side meaning", async () => {
    const changes = { changes: [{ service: "app", key: "PASSWORD", value: "" }] };
    const path = await file(changes);
    fetchStub = stubFetch(request => {
      expect(request.method).toBe("PATCH");
      expect(request.url).toBe("http://api.test/api/projects/project-a/app-settings");
      expect(request.body).toEqual(changes);
      return { json: { data: { count: 0, requiresRedeploy: false } } };
    });
    const result = await runCommand(appCommand, ["settings", "update", "project-a", path]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toEqual({ count: 0, requiresRedeploy: false });
  });
  it("propagates SDK validation failures before sending malformed routing choices", async () => {
    const path = await file([{ service: "app", port: 70000, mode: "port" }]);
    fetchStub = stubFetch(() => { throw new Error("must not send invalid input"); });
    const result = await runCommand(appCommand, ["install", "custom-app", "--routes", path]);
    expect(result.code).toBe(1);
    expect(fetchStub.calls).toHaveLength(0);
  });
});
