import "../jobs/_env";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAssistantClient } from "@repo/platform/engine/modules/assistant/native-target";
import { probeHarness } from "@repo/platform/engine/modules/assistant/harness-policy";
import { probeLocalGitHubToken } from "@repo/adapters";

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Cloud local agent and credential execution floor", () => {
  it.each(["true", "1"])(
    "rejects local Mindwire startup before creating its private host state (%s)",
    async (mode) => {
      const root = await mkdtemp(join(tmpdir(), "openship-cloud-local-agent-"));
      dirs.push(root);
      const directory = join(root, "must-not-exist");
      vi.stubEnv("CLOUD_MODE", mode);
      await expect(createAssistantClient(directory, "tenant-user")).rejects.toMatchObject({
        statusCode: 403,
        code: "LOCAL_HOST_ACCESS_DENIED",
      });
      await expect(access(directory)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
  it("rejects direct local harness and host GitHub-token probes", async () => {
    vi.stubEnv("CLOUD_MODE", "true");
    await expect(probeHarness("codex", process.env.PATH ?? "", {})).rejects.toMatchObject({
      code: "LOCAL_HOST_ACCESS_DENIED",
    });
    await expect(probeLocalGitHubToken("/must-not-execute")).rejects.toMatchObject({
      code: "LOCAL_HOST_ACCESS_DENIED",
    });
  });
});
