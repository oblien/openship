import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exec as shellExec } from "node:child_process";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { LocalExecutor } from "@repo/adapters";

const { acquire } = vi.hoisted(() => ({ acquire: vi.fn() }));
vi.mock("@repo/platform/engine/lib/ssh-manager", () => ({ sshManager: { acquire } }));
vi.mock("@repo/platform/engine/lib/ssh-tunnel", () => ({
  tunnelRequest: vi.fn(async () => null),
  tunnelStream: vi.fn(),
}));
vi.mock("@repo/adapters", async (original) => ({
  ...(await original<typeof import("@repo/adapters")>()),
  resolveOurEdgeContainer: async () => "fixture-edge",
}));

const { postEdgeMgmt } = await import("@repo/platform/engine/lib/edge-management");
const exec = promisify(shellExec);
let server: Server | undefined;
let directory: string | undefined;
const files: string[] = [];
let local: LocalExecutor;
beforeEach(() => {
  vi.stubEnv("CLOUD_MODE", "false");
  local = new LocalExecutor();
});
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
  for (const file of files.splice(0)) await rm(file, { force: true });
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
  await local.dispose();
  vi.unstubAllEnvs();
});

describe("large edge management requests", () => {
  it.each([
    { transport: "stdin", bytes: 64000 },
    { transport: "file", bytes: 64000 },
    { transport: "tunnel fallback", bytes: 64000 },
    { transport: "stdin", bytes: 0 },
    { transport: "file", bytes: 0 },
  ])(
    "delivers literal JSON via $transport ($bytes padding bytes) and preserves large replies",
    async ({ transport, bytes }) => {
      directory = await mkdtemp(join(tmpdir(), "openship-response-transport-"));
      const marker = join(directory, "must-not-execute");
      const literal = `'; touch ${marker}; $(touch ${marker}) \`touch ${marker}\`\nمرحبا\u0000`;
      const payload = {
        host: "response.test",
        rules: Array.from({ length: 4 }, (_, i) => ({
          pathPrefix: `/response/${i}`,
          spec: { response: { body: literal + "x".repeat(bytes) } },
        })),
      };
      const reply = { ok: true, count: 4, collected: "مرحبا".repeat(10000) };
      let received = "";
      server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        received = Buffer.concat(chunks).toString("utf8");
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(reply));
      });
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing fixture port");
      const stdin = transport !== "file";
      const hostWrite = vi.fn(async (path: string, body: string, options: { mode: number }) => {
        files.push(path);
        await writeFile(path, body, options);
        expect((await stat(path)).mode & 0o777).toBe(0o600);
      });
      const hostRemove = vi.fn((path: string) => rm(path, { force: true }));
      const toLocal = (command: string, input = false) => {
        if (Buffer.byteLength(command) >= 128 * 1024) throw new Error("E2BIG");
        const prefix = `docker exec ${input ? "-i " : ""}'fixture-edge' `;
        if (!command.startsWith(prefix)) throw new Error("Unexpected fixture command");
        return command.slice(prefix.length).replace("127.0.0.1:9145", `127.0.0.1:${address.port}`);
      };
      acquire.mockResolvedValue({
        ...(transport === "tunnel fallback" ? { forwardPort: vi.fn() } : {}),
        ...(stdin
          ? {
              execWithInput: async (command: string, body: import("node:stream").Readable) => {
                const path = command.match(/\/tmp\/openship-edge-request-[\w-]+\.json/)?.[0];
                if (!path) throw new Error("Missing private upload path");
                files.push(path);
                const result = await local.execWithInput(toLocal(command, true), body);
                expect((await stat(path)).mode & 0o777).toBe(0o600);
                return result;
              },
            }
          : {}),
        writeFile: hostWrite,
        rm: hostRemove,
        exec: async (command: string) => {
          // Only Docker isolation is elided: stdin, curl, shell, files and HTTP
          // are real. The fixture shares the container's file with the host.
          if (command.startsWith("docker cp ")) {
            if (stdin) throw new Error("stdin-capable executors must not stage a host copy");
            return "";
          }
          return (await exec(toLocal(command))).stdout;
        },
      });
      await expect(postEdgeMgmt("fixture-server", "/rules", payload)).resolves.toEqual(reply);
      expect(JSON.parse(received)).toEqual(payload);
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
      expect(files).toHaveLength(1);
      await expect(access(files[0]!)).rejects.toMatchObject({ code: "ENOENT" });
      if (stdin) {
        expect(hostWrite).not.toHaveBeenCalled();
        expect(hostRemove).not.toHaveBeenCalled();
      }
    },
  );

  it("cleans up a failed stdin upload without publishing or retrying through a host copy", async () => {
    const hostWrite = vi.fn();
    const commands: string[] = [];
    acquire.mockResolvedValue({
      execWithInput: async (command: string) => {
        const path = command.match(/\/tmp\/openship-edge-request-[\w-]+\.json/)?.[0];
        if (!path) throw new Error("Missing upload path");
        files.push(path);
        await writeFile(path, "partial", { mode: 0o600 });
        return { code: 1, stdout: "", stderr: "connection interrupted" };
      },
      exec: async (command: string) => {
        commands.push(command);
        if (command.includes("curl") || command.startsWith("docker cp "))
          throw new Error("Failed upload must not publish");
        return (await exec(command.slice("docker exec 'fixture-edge' ".length))).stdout;
      },
      writeFile: hostWrite,
    });
    await expect(
      postEdgeMgmt("fixture-server", "/rules", { body: "x".repeat(65536) }),
    ).resolves.toBeNull();
    expect(hostWrite).not.toHaveBeenCalled();
    expect(
      commands.some((command) => command.includes("curl") || command.startsWith("docker cp ")),
    ).toBe(false);
    expect(files).toHaveLength(1);
    await expect(access(files[0]!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans up private request files when copying to the edge fails", async () => {
    acquire.mockResolvedValue({
      writeFile: async (path: string, body: string, options: { mode: number }) => {
        files.push(path);
        await writeFile(path, body, options);
      },
      exec: async (command: string) => {
        if (command.startsWith("docker cp ")) throw new Error("edge unavailable");
        return "";
      },
      rm: (path: string) => rm(path, { force: true }),
    });
    await expect(
      postEdgeMgmt("fixture-server", "/rules", { body: "x".repeat(65536) }),
    ).resolves.toBeNull();
    expect(files).toHaveLength(1);
    await expect(readFile(files[0]!)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
