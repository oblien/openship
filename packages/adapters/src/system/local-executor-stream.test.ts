import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { LocalExecutor } from "./local-executor";
import { sq } from "./local-shell";
import { BareRuntime } from "../runtime/bare";
import { BareBackupExecutor } from "../backup/executors/bare";
import { CustomCommandProducer } from "../backup/producers/custom-command";

const executors: LocalExecutor[] = [];
const dirs: string[] = [];
const node = (script: string) => `${sq(process.execPath)} -e ${sq(script)}`;
function executor() {
  vi.stubEnv("CLOUD_MODE", "false");
  const result = new LocalExecutor();
  executors.push(result);
  return result;
}
afterEach(async () => {
  await Promise.all(executors.splice(0).map((exec) => exec.dispose()));
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  vi.unstubAllEnvs();
});

describe("local bare backup command streams", () => {
  it("captures and restores a binary artifact through the real bare executor", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openship-local-backup-"));
    dirs.push(dir);
    const file = join(dir, "restored.bin");
    const transport = executor();
    const bare = new BareBackupExecutor(new BareRuntime({ executor: transport }));
    const service = { id: "mail", name: "mail", projectId: "", volumes: [], env: {} } as never;
    const payload = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const expected = createHash("sha256");
    for (let i = 0; i < 8192; i++) expected.update(payload);
    const capture = await bare.execStream(service, [
      "sh",
      "-c",
      node(
        "const b=Buffer.from(Array.from({length:256},(_,i)=>i));for(let i=0;i<8192;i++)process.stdout.write(b)",
      ),
    ]);
    const hash = createHash("sha256");
    const restore = bare.pipeIntoCommand(
      service,
      ["sh", "-c", `cat > ${sq(file)}`],
      capture.stdout,
    );
    expect(await restore).toMatchObject({ code: 0 });
    expect(await capture.awaitExit).toMatchObject({ code: 0 });
    const restored = await readFile(file);
    hash.update(restored);
    expect(restored.length).toBe(256 * 8192);
    expect(hash.digest("hex")).toBe(expected.digest("hex"));
  });

  it("preserves a failing loader's exit status and bounded diagnostic tail", async () => {
    const exec = executor();
    const result = await exec.execWithInput(
      node(
        "process.stdin.resume();process.stdin.on('end',()=>{process.stderr.write('x'.repeat(32768)+'loader failed');process.exitCode=42})",
      ),
      Readable.from([Buffer.from([0, 255, 128])]),
    );
    expect(result.code).toBe(42);
    expect(result.stderr).toHaveLength(16 * 1024);
    expect(result.stderr).toMatch(/loader failed$/);
  });

  it("propagates an input failure instead of accepting a partial restore", async () => {
    const exec = executor();
    const source = Readable.from(
      (async function* () {
        yield Buffer.from("partial");
        throw new Error("object download interrupted");
      })(),
    );
    await expect(exec.execWithInput("cat >/dev/null", source)).rejects.toThrow(
      "object download interrupted",
    );
  });

  it("cancels a command that has consumed stdin but is still running", async () => {
    const exec = executor();
    const cancel = new AbortController();
    const result = exec.runWithAbortSignal(cancel.signal, () =>
      exec.execWithInput(
        node("process.stdin.resume();process.stdin.on('end',()=>setInterval(()=>{},1000))"),
        Readable.from(["data"]),
      ),
    );
    const assertion = expect(result).rejects.toThrow("stop restore");
    setTimeout(() => cancel.abort(new Error("stop restore")), 150);
    await assertion;
  });

  it("forwards restore cancellation through the shared custom-command producer", async () => {
    const transport = executor();
    const bare = new BareBackupExecutor(new BareRuntime({ executor: transport }));
    const cancel = new AbortController();
    const service = { id: "mail", name: "mail", projectId: "", volumes: [], env: {} } as never;
    const restore = CustomCommandProducer.restore(
      service,
      bare,
      {
        key: "mail.tar.zst",
        payloadKind: "custom_command",
        sha256: "",
        sizeBytes: 4,
        metadata: {
          restoreCommand: node(
            "process.stdin.resume();process.stdin.on('end',()=>setInterval(()=>{},1000))",
          ),
        },
        open: async () => Readable.from(["mail"]),
      },
      { signal: cancel.signal },
    );
    const assertion = expect(restore).rejects.toThrow("stop mail restore");
    setTimeout(() => cancel.abort(new Error("stop mail restore")), 150);
    await assertion;
  });

  it("streams with backpressure and reports a capture failure", async () => {
    const exec = executor();
    const capture = await exec.rawExec(
      node(
        "process.stdout.write(Buffer.alloc(100000));process.stderr.write('capture failed');process.exitCode=7",
      ),
    );
    let bytes = 0;
    let stderr = "";
    capture.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    await pipeline(
      capture.stdout,
      new Writable({
        highWaterMark: 1024,
        write(chunk, _encoding, done) {
          bytes += chunk.length;
          setTimeout(done, 1);
        },
      }),
    );
    expect(await capture.onClose).toBe(7);
    expect(bytes).toBe(100000);
    expect(stderr).toBe("capture failed");
  });
});
