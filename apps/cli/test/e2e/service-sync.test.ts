import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const h = vi.hoisted(() => ({ spawnSync: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawnSync: h.spawnSync,
}));
vi.mock("../../src/lib/config", () => ({
  getApiUrl: () => "http://api.test",
  getToken: () => "token",
}));

import { serviceCommand } from "../../src/commands/service";
import { runCommand, stubFetch, type FetchStub } from "../helpers/harness";
import { serviceFixture } from "../../../../packages/contracts/test/fixtures";

let root: string | undefined;
let fetchStub: FetchStub | undefined;
afterEach(async () => {
  fetchStub?.restore();
  vi.unstubAllEnvs();
  h.spawnSync.mockReset();
  if (root) await rm(root, { recursive: true, force: true });
});

describe("service sync source handling", () => {
  it.each([200, 503])(
    "sends only service configuration and creates no archive (HTTP %s)",
    async (status) => {
      root = await mkdtemp(join(tmpdir(), "openship-service-sync-test-"));
      const scratch = join(root, "tmp");
      const source = join(root, "source");
      await mkdir(scratch);
      await mkdir(join(source, "node_modules"), { recursive: true });
      await writeFile(join(source, "node_modules/large-dependency"), "excluded from config sync");
      const composeFile = join(source, "compose.yaml");
      await writeFile(composeFile, "services:\n  web:\n    build: .\n");
      vi.stubEnv("TMPDIR", scratch);
      h.spawnSync.mockReturnValue({
        status: 0,
        stdout: JSON.stringify({ services: { web: { build: { context: source } } } }),
        stderr: "",
      });
      fetchStub = stubFetch(() => {
        return status === 200
          ? { json: { success: true, services: [serviceFixture("svc_a", "proj_a")] } }
          : { status, json: { error: "Service unavailable" } };
      });

      const result = await runCommand(serviceCommand, [
        "sync",
        composeFile,
        "-p",
        "proj_a",
        "--yes",
      ]);
      expect(result.code, result.out + result.err).toBe(status === 200 ? 0 : 1);
      expect(fetchStub.calls).toHaveLength(1);
      expect(fetchStub.calls[0]).toMatchObject({
        url: "http://api.test/api/projects/proj_a/services/sync",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: { services: [{ name: "web", build: "." }] },
      });
      expect(h.spawnSync).toHaveBeenCalledExactlyOnceWith(
        "docker",
        ["compose", "-f", composeFile, "config", "--format", "json"],
        expect.any(Object),
      );
      expect(await readdir(scratch)).toEqual([]);
      expect(await readdir(source)).toEqual(["compose.yaml", "node_modules"]);
    },
  );
});
