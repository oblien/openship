import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../../src/lib/config", () => ({
  getApiUrl: () => "https://controller.example.test",
  getToken: () => "opsh_pat_fixture",
}));
import { projectRoutingCommand } from "../../src/commands/project-management";
import { setJsonMode } from "../../src/lib/output";
import { runCommand, stubFetch, type FetchStub } from "../helpers/harness";

let fetchStub: FetchStub;
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "openship-route-cli-"));
  setJsonMode(true);
  fetchStub = stubFetch(() => ({
    json: { data: { hostname: "private.test", enabled: true, status: "pending" } },
  }));
});
afterEach(() => {
  fetchStub.restore();
  setJsonMode(false);
  rmSync(directory, { recursive: true, force: true });
});

it("reads a password without losing spaces or echoing it and preserves pending edge status", async () => {
  const password = "  keep these password spaces  ";
  const file = join(directory, "password");
  writeFileSync(file, password + "\n", { mode: 0o600 });
  const result = await runCommand(projectRoutingCommand, [
    "protection",
    "protect",
    "proj_one",
    "private.test",
    "--password-file",
    file,
  ]);
  expect(result.code, result.err).toBe(0);
  expect(fetchStub.calls).toHaveLength(1);
  expect(fetchStub.calls[0]).toMatchObject({
    method: "PUT",
    url: "https://controller.example.test/api/projects/proj_one/route-protection",
    body: { hostname: "private.test", action: "protect", password },
  });
  expect(JSON.parse(result.out)).toMatchObject({ status: "pending" });
  expect(result.out + result.err).not.toContain(password);
});

it("requires confirmation before making a route public in automation", async () => {
  const args = ["protection", "unlock", "proj_one", "private.test"];
  expect((await runCommand(projectRoutingCommand, args)).code).toBe(1);
  expect(fetchStub.calls).toEqual([]);
  expect((await runCommand(projectRoutingCommand, [...args, "--yes"])).code).toBe(0);
  expect(fetchStub.calls[0].body).toEqual({ hostname: "private.test", action: "unlock" });
});
