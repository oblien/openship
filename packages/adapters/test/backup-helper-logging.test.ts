import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServiceHandle } from "../src/backup/types";
import { FakeAttachStream, harness } from "./helpers/docker-helper-harness";

/**
 * The backup helper streams a volume's archive over `attach()`. With the
 * daemon's default json-file driver, Docker ALSO writes every byte to
 * /var/lib/docker/containers — a second copy of the whole backup, inflated
 * further because json-file escapes binary. Observed on a live box: a 4.6 GB
 * volume produced a 12 GB log, so a backup spiked host disk by far more than
 * it read and only released it when the helper exited.
 *
 * Exercise the executor's actual helper configuration for each codec.
 */
const attach = vi.hoisted(() => ({ stream: null as FakeAttachStream | null }));
vi.mock("../src/runtime/docker-exec-stream", async (original) => ({
  ...(await original<typeof import("../src/runtime/docker-exec-stream")>()),
  startAttachStream: async () => attach.stream!,
}));

afterEach(() => vi.restoreAllMocks());

const service: ServiceHandle = {
  id: "svc_1",
  projectId: "prj_1",
  name: "db",
  image: "postgres:16",
  env: {},
  volumes: ["pgdata:/var/lib/postgresql/data"],
  containerId: null,
  projectSlug: "shop",
  namespaceVolumes: false,
};

describe("backup helper container", () => {
  it.each(["none", "gzip", "zstd"] as const)(
    "keeps %s capture read-only with logging disabled and cleanup owned by the executor",
    async (compression) => {
      attach.stream = new FakeAttachStream();
      const h = harness({ wait: 0 }, () => ({}));
      const executor = await h.executor();
      const { stdout, awaitExit } = await executor.streamPath(service, "pgdata-0", { compression });
      stdout.resume();
      attach.stream.finish();
      await awaitExit;
      expect(h.created.at(-1)?.HostConfig).toMatchObject({
        Mounts: [{ Type: "volume", Source: "pgdata", Target: "/mnt", ReadOnly: true }],
        AutoRemove: false,
        LogConfig: { Type: "none", Config: {} },
      });
      expect(h.removals).toHaveLength(1);
    },
  );
});
