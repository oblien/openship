/**
 * The bare executor's restore ceiling was applied only when a caller named one — and
 * `receiveStream`, the path every mail-server restore takes, named none. Neither
 * `execWithInput` nor `transferIn` has a timeout of its own, so a wedged remote loader
 * left nothing that would ever settle and the restore row sat in `applying`.
 *
 * Same defect the docker executor had, on the second copy of the byte plane — which is
 * why it gets the same tests. Both directions of the fallback are covered too: the
 * staging path is what a non-SSH executor takes, and it had no bound anywhere.
 */

import { PassThrough, Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BareBackupExecutor } from "./bare";
import type { ServiceHandle } from "../types";

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

const service = {
  id: "svc_1",
  projectId: "prj_1",
  projectSlug: "mail",
  name: "mail-server",
  image: "iredmail",
  env: {},
  volumes: ["/var/vmail"],
  containerId: null,
} as unknown as ServiceHandle;

function executorWith(commandExecutor: Record<string, unknown>): BareBackupExecutor {
  return new BareBackupExecutor({ commandExecutor } as never);
}

/** An SSH-shaped executor whose remote command never exits. */
function wedgedStreaming() {
  const calls: string[] = [];
  return {
    calls,
    exec: {
      rawExec: async () => {
        throw new Error("the streaming path must not fall back to rawExec");
      },
      execWithInput: async (command: string) => {
        calls.push(command);
        return new Promise<never>(() => {});
      },
      transferIn: async () => {
        throw new Error("the streaming path must not stage");
      },
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("BareBackupExecutor.pipeIntoCommand ceiling", () => {
  it("bounds a restore the caller gave no ceiling for", async () => {
    vi.useFakeTimers();
    const { exec } = wedgedStreaming();
    const body = new PassThrough();
    body.write(Buffer.from("dump"));

    const pending = executorWith(exec).pipeIntoCommand(service, ["sh", "-c", "psql"], body);
    const assertion = expect(pending).rejects.toThrow(
      /exceeded its 21600s ceiling and was abandoned\. The target may hold partial data/,
    );
    await vi.advanceTimersByTimeAsync(SIX_HOURS_MS);
    await assertion;

    // Closing the body is the teardown that reaches the far side: the remote command
    // sees EOF on stdin. Leaving it open kept feeding a loader nobody was waiting for.
    expect(body.destroyed).toBe(true);
  });

  it("receiveStream forwards its ceiling instead of dropping it", async () => {
    const { exec } = wedgedStreaming();
    await expect(
      executorWith(exec).receiveStream(service, "/var/vmail", Readable.from(["tar"]), {
        timeoutMs: 80,
      }),
    ).rejects.toThrow(/exceeded its 0s ceiling/);
  });

  it("bounds the staging fallback's transfer, and cleans up after it", async () => {
    const { readdir } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const staged = () =>
      readdir(tmpdir())
        .then((names) => names.filter((n) => n.startsWith("openship-bare-restore-")))
        .catch(() => [] as string[]);
    const before = await staged();

    // No `execWithInput` — the shape a local, non-SSH CommandExecutor has, which is the
    // only way into the staging branch.
    const exec = {
      rawExec: async () => {
        throw new Error("the transfer never finished, so nothing should run");
      },
      transferIn: async () => new Promise<never>(() => {}),
    };

    await expect(
      executorWith(exec).pipeIntoCommand(service, ["sh", "-c", "psql"], Readable.from(["dump"]), {
        timeoutMs: 120,
      }),
    ).rejects.toThrow(/may hold partial data/);

    // The staged artifact is the module's last unbounded resource — a ceiling that
    // leaked it would fill the control plane's disk one abandoned restore at a time.
    expect(await staged()).toEqual(before);
  });

  it("hands the staging fallback's remaining budget to the exec itself", async () => {
    let killed = false;
    let onClose: (code: number) => void = () => {};
    const exec = {
      rawExec: async () => ({
        stdout: Readable.from([]),
        stderr: new PassThrough(),
        onClose: new Promise<number>((resolve) => {
          onClose = resolve;
        }),
        // What `execStream`'s own ceiling reaches for. Before the budget was forwarded
        // this was never called, because there was no ceiling to reach it with.
        kill: () => {
          killed = true;
          onClose(137);
        },
      }),
      transferIn: async () => {},
    };

    const exit = await executorWith(exec).pipeIntoCommand(
      service,
      ["sh", "-c", "psql"],
      Readable.from(["dump"]),
      { timeoutMs: 150 },
    );

    expect(killed).toBe(true);
    expect(exit.code).toBe(137);
  });
});
