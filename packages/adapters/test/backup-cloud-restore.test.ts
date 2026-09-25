import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { gzipSync } from "node:zlib";
import { Runtime } from "oblien";
import * as tarFs from "tar-fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shellQuote } from "@repo/core";
import { CloudBackupExecutor } from "../src/backup/executors/cloud";
import type { CloudRuntime } from "../src/runtime/cloud";
import type { ServiceHandle } from "../src/backup/types";

const service: ServiceHandle = {
  id: "service",
  projectId: "project",
  name: "app",
  image: null,
  env: {},
  volumes: [],
  containerId: "workspace",
  projectSlug: "project",
  namespaceVolumes: false,
};

async function collect(stream: Readable) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

let root: string;
let server: Server;
let executor: CloudBackupExecutor;
let uploadMode: "normal" | "failed" | "truncated";
let destinations: string[];
let commands: string[];
const tasks = new Map<string, ChildProcess>();

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openship-cloud-restore-test-"));
  destinations = [];
  commands = [];
  uploadMode = "normal";
  // Exercise the installed SDK over HTTP. This endpoint, like Cloud's, ONLY
  // accepts tar.gz into a directory; no compression/clearTarget/file-path hints.
  server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url!, "http://localhost");
      expect(url.pathname).toBe("/files/transfer/upload");
      expect(req.headers["content-type"]).toBe("application/gzip");
      const dest = url.searchParams.get("dest")!;
      expect(dest).toMatch(/^\/tmp\/openship-restore-[a-f0-9-]+$/);
      destinations.push(dest);
      expect((await stat(dest)).mode & 0o777).toBe(0o700);
      if (uploadMode === "failed") {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "storage unavailable" }));
        req.resume();
        return;
      }
      const child = spawn("tar", ["-xz", "-C", dest], { stdio: ["pipe", "ignore", "pipe"] });
      const exited = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      child.stderr.resume();
      await pipeline(req, child.stdin);
      expect(await exited).toBe(0);
      expect((await stat(join(dest, "artifact.bin"))).mode & 0o777).toBe(0o600);
      if (uploadMode === "truncated") await writeFile(join(dest, "artifact.bin"), "cut");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, files_extracted: 1 }));
    })().catch((error) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const rt = new Runtime({ token: "backup-test-only", baseUrl: `http://127.0.0.1:${port}` });
  const stream = vi.fn(async function* (argv: string[]) {
    commands.push(argv.at(-1)!);
    const id = randomUUID();
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    tasks.set(id, child);
    const exited = new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 137));
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-16 * 1024);
    });
    try {
      yield { event: "task_id", task_id: id };
      for await (const chunk of child.stdout) {
        yield { event: "stdout", data: Buffer.from(chunk).toString("base64") };
      }
      if (stderr) yield { event: "stderr", data: Buffer.from(stderr).toString("base64") };
      yield { event: "exit", exit_code: await exited };
    } finally {
      child.kill();
      tasks.delete(id);
    }
  });
  executor = new CloudBackupExecutor({
    client: {
      workspace: () => ({
        runtime: async () => ({
          transfer: rt.transfer,
          exec: {
            stream,
            kill: async (id: string) => {
              tasks.get(id)?.kill();
            },
          },
        }),
      }),
    },
  } as unknown as CloudRuntime);
});

afterEach(async () => {
  for (const child of tasks.values()) child.kill("SIGKILL");
  tasks.clear();
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const dir of destinations ?? []) await rm(dir, { recursive: true, force: true });
  if (root) await rm(root, { recursive: true, force: true });
});

describe("native Cloud restore through the SDK's tar.gz upload contract", () => {
  it("loads raw binary stdin, preserves env/cwd and removes private staging", async () => {
    const expected = randomBytes(512 * 1024);
    const output = join(root, "restored.dump");
    const exit = await executor.pipeIntoCommand(
      service,
      ["sh", "-c", 'cat > "$OUTPUT"'],
      Readable.from([expected]),
      {
        cwd: root,
        env: { OUTPUT: "restored.dump" },
      },
    );
    expect(exit.code, exit.stderr).toBe(0);
    expect(await readFile(output)).toEqual(expected);
    expect(destinations).toHaveLength(1);
    await expect(stat(destinations[0]!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["none", "gzip"] as const)(
    "restores a %s archive and clears every old child, including dotfiles",
    async (compression) => {
      const source = join(root, "source");
      const target = join(root, "it's restored");
      await mkdir(source);
      await mkdir(target);
      const expected = randomBytes(64 * 1024);
      await writeFile(join(source, "data.bin"), expected);
      await writeFile(join(target, "old"), "old");
      await writeFile(join(target, "..old"), "old hidden");
      const tar = await collect(tarFs.pack(source));
      const archive = compression === "gzip" ? gzipSync(tar) : tar;
      const restored = await executor.receiveStream(service, target, Readable.from([archive]), {
        compression,
        clearTarget: true,
      });
      expect(restored.bytesWritten).toBe(archive.length);
      expect(await readFile(join(target, "data.bin"))).toEqual(expected);
      await expect(stat(join(target, "old"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(join(target, "..old"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(destinations[0]!)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("keeps the target untouched and cleans up a failed upload", async () => {
    uploadMode = "failed";
    const output = join(root, "keep");
    await writeFile(output, "existing data");
    await expect(
      executor.pipeIntoCommand(
        service,
        ["sh", "-c", `cat > ${shellQuote(output)}`],
        Readable.from(["replacement"]),
      ),
    ).rejects.toThrow();
    expect(await readFile(output, "utf8")).toBe("existing data");
    await expect(stat(destinations[0]!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses incomplete staging before starting the loader", async () => {
    uploadMode = "truncated";
    const output = join(root, "keep");
    await writeFile(output, "existing data");
    const exit = await executor.pipeIntoCommand(
      service,
      ["sh", "-c", `cat > ${shellQuote(output)}`],
      Readable.from(["replacement"]),
    );
    expect(exit.code).toBe(91);
    expect(exit.stderr).toContain("staging was incomplete");
    expect(await readFile(output, "utf8")).toBe("existing data");
    await expect(stat(destinations[0]!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the loader's failure and removes its staged backup", async () => {
    const exit = await executor.pipeIntoCommand(
      service,
      ["sh", "-c", "cat >/dev/null; echo rejected >&2; exit 7"],
      Readable.from(["dump"]),
    );
    expect(exit).toEqual({ code: 7, stderr: "rejected\n" });
    await expect(stat(destinations[0]!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("honors cancellation before staging and refuses unsupported freeze requests", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled by operator"));
    const body = Readable.from(["dump"]);
    await expect(
      executor.pipeIntoCommand(service, ["cat"], body, { signal: controller.signal }),
    ).rejects.toThrow("cancelled by operator");
    expect(body.destroyed).toBe(true);
    expect(commands).toHaveLength(0);
    expect(destinations).toHaveLength(0);
    await expect(executor.streamPath(service, "/app", { quiesce: true })).rejects.toThrow(
      "cannot freeze",
    );
    expect(executor.supportsOfflineVolumeRestore).toBe(false);
  });
});
