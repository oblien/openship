/**
 * "Nothing to back up" is a failure, not a successful backup of nothing.
 *
 * `VolumeCopyProducer.produce` used to `return` when `listSources()` came back
 * empty, with a comment saying the orchestrator would record it as "a successful
 * zero-artifact run" — which it did. That is
 * [#611](https://github.com/oblien/openship/issues/611): a policy on the control
 * plane's own postgres finishing green in two seconds having uploaded nothing.
 *
 * The message is asserted, not just the throw, because it is the only thing the
 * operator sees and the two causes need different actions from them: a live
 * container that genuinely has no mounts, versus a service row Openship adopted and
 * therefore never recorded volumes for.
 */

import { describe, expect, it } from "vitest";
import { VolumeCopyProducer } from "../src/backup/producers/volume";
import type { BackupExecutor, BackupSource, ServiceHandle } from "../src/backup/types";

function service(over: Partial<ServiceHandle> = {}): ServiceHandle {
  return {
    id: "svc_1",
    projectId: "prj_1",
    name: "postgres",
    image: "postgres:16-alpine",
    env: {},
    volumes: [],
    containerId: null,
    projectSlug: "openship",
    namespaceVolumes: false,
    ...over,
  };
}

const executorWith = (sources: BackupSource[]) =>
  ({ listSources: async () => sources }) as unknown as BackupExecutor;

/** Drain the async generator so its throw surfaces. */
async function produce(svc: ServiceHandle, exec: BackupExecutor, opts = {}) {
  const out = [];
  for await (const a of VolumeCopyProducer.produce(svc, exec, opts as never)) out.push(a);
  return out;
}

describe("a service with no backupable source fails the run", () => {
  it("explains an adopted service — no container, so only recorded volumes were seen", async () => {
    // The reported shape: rows created from running containers carry no `volumes`,
    // and the bare executor can read nothing else.
    await expect(produce(service(), executorWith([]))).rejects.toThrow(
      /Nothing to back up.*no volumes or bind mounts found for service "postgres"/s,
    );
    await expect(produce(service(), executorWith([]))).rejects.toThrow(
      /No container was resolved for it/,
    );
  });

  it("explains a live container that genuinely has no mounts", async () => {
    // Same failure, different diagnosis — and the container id is the evidence.
    await expect(
      produce(service({ containerId: "abcdef0123456789" }), executorWith([])),
    ).rejects.toThrow(/live container \(abcdef012345\) reports no volume or bind mounts/);
  });

  it("fails when every source is tmpfs, naming what it found", async () => {
    // tmpfs holds nothing across a restart, so filtering it out leaves nothing —
    // the same "captured nothing" outcome one step later.
    await expect(
      produce(
        service({ containerId: "c1" }),
        executorWith([{ id: "scratch", source: "", target: "/tmp", type: "tmpfs" }]),
      ),
    ).rejects.toThrow(/only mounts are tmpfs.*scratch \(tmpfs\)/s);
  });

  it("fails when the policy selects source ids the service does not have", async () => {
    await expect(
      produce(
        service({ containerId: "c1" }),
        executorWith([{ id: "pgdata", source: "pgdata", target: "/var/lib", type: "volume" }]),
        { sourceIds: ["typo-data"] },
      ),
    ).rejects.toThrow(/selects typo-data, none of which is a source.*pgdata \(volume\)/s);
  });

  it("still produces normally when there IS a volume", async () => {
    // The guard must not be so eager that it fails an honest volume backup.
    const exec = {
      listSources: async () => [
        { id: "pgdata", source: "openship-pgdata", target: "/var/lib", type: "volume" as const },
      ],
      streamPath: async () => ({
        stdout: (await import("node:stream")).Readable.from([Buffer.from("tar")]),
        awaitExit: Promise.resolve({ code: 0, stderr: "" }),
      }),
    } as unknown as BackupExecutor;

    const artifacts = await produce(service({ containerId: "c1" }), exec);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]!.name).toBe("volume-pgdata.tar.zst");
  });

  it("forwards quiesce to the executor and records what the archive IS", async () => {
    // The artifact has to say which consistency it got, because an operator cannot tell by
    // looking and the two are not interchangeable: `crash` means the app kept writing while
    // tar walked the tree. Recording it is the same principle as `meta.integrity` — the run
    // states what it actually did rather than what was hoped for.
    const seen: Array<{ quiesce?: boolean }> = [];
    const exec = {
      listSources: async () => [
        { id: "pgdata", source: "openship-pgdata", target: "/var/lib", type: "volume" as const },
      ],
      streamPath: async (_s: unknown, _id: string, o: { quiesce?: boolean }) => {
        seen.push({ quiesce: o.quiesce });
        return {
          stdout: (await import("node:stream")).Readable.from([Buffer.from("tar")]),
          awaitExit: Promise.resolve({ code: 0, stderr: "" }),
        };
      },
    } as unknown as BackupExecutor;

    const quiesced = await produce(service({ containerId: "c1" }), exec, { quiesce: true });
    expect(seen[0]?.quiesce).toBe(true);
    expect(quiesced[0]!.metadata.consistency).toBe("quiesced");

    seen.length = 0;
    const plain = await produce(service({ containerId: "c1" }), exec, {});
    expect(seen[0]?.quiesce).toBeUndefined();
    // Not silently labelled as something stronger than it is.
    expect(plain[0]!.metadata.consistency).toBe("crash");
  });
});
