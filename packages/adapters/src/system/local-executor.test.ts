/**
 * The local command transport's byte plane.
 *
 * A bare install's "This Server" row runs every command through LocalExecutor. It had
 * no `rawExec`, so the bare backup executor refused every capture on that host —
 * including the built-in mail server — with "Bare backups require a command transport
 * that supports streaming". These run real local processes: the contract under test is
 * the child_process wiring itself.
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BareBackupExecutor } from "../backup/executors/bare";
import type { ServiceHandle } from "../backup/types";
import { LocalExecutor } from "./local-executor";

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "openship-local-exec-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("LocalExecutor.rawExec", () => {
  it("streams stdout byte-for-byte and reports the exit code", async () => {
    const exec = new LocalExecutor();
    const child = await exec.rawExec(String.raw`printf '\000\001\377\n\r'; printf oops >&2; exit 3`);
    const [stdout, stderr, code] = await Promise.all([
      collect(child.stdout),
      collect(child.stderr),
      child.onClose,
    ]);
    expect([...stdout]).toEqual([0, 1, 255, 10, 13]);
    expect(stderr.toString()).toBe("oops");
    expect(code).toBe(3);
  });

  it("kill ends a command that would otherwise run on", async () => {
    const exec = new LocalExecutor();
    const child = await exec.rawExec("sleep 30");
    child.stdout.resume();
    child.stderr.resume();
    child.kill();
    expect(await child.onClose).not.toBe(0);
  });
});

describe("LocalExecutor.execWithInput", () => {
  it("pipes the body into stdin and closes it at EOF", async () => {
    const exec = new LocalExecutor();
    const target = join(dir, "out.bin");
    const result = await exec.execWithInput(`cat > '${target}'; echo done`, Readable.from([Buffer.from([0, 255, 10])]));
    expect(result).toEqual({ code: 0, stderr: "", stdout: "done" });
    expect([...(await readFile(target))]).toEqual([0, 255, 10]);
  });

  it("rejects and kills the loader when the source fails", async () => {
    const exec = new LocalExecutor();
    const body = new PassThrough();
    const pending = exec.execWithInput("cat > /dev/null", body);
    body.write("partial");
    body.destroy(new Error("source broke"));
    await expect(pending).rejects.toThrow("source broke");
  });
});

describe("bare backups on the local host", () => {
  it("captures a host-level source through the local transport", async () => {
    const source = join(dir, "vmail");
    await mkdir(source);
    await writeFile(join(source, "message.eml"), "hello");

    const runtime = { commandExecutor: new LocalExecutor(), scopedProjectId: undefined };
    const backup = new BareBackupExecutor(runtime as never);
    const service = {
      id: "svc_mail",
      projectId: null,
      name: "mail-server",
      env: {},
      volumes: [source],
      containerId: null,
    } as unknown as ServiceHandle;

    const { stdout, awaitExit } = await backup.streamPath(service, source, { compression: "gzip" });
    const archive = await collect(stdout);
    expect((await awaitExit).code).toBe(0);

    const restored = join(dir, "restored");
    await mkdir(restored);
    const untar = await new LocalExecutor().execWithInput(`tar -xz -C '${restored}'`, Readable.from([archive]));
    expect(untar.code).toBe(0);
    expect(await readFile(join(restored, "message.eml"), "utf8")).toBe("hello");
  });
});
