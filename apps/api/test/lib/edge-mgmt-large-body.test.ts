import { afterEach, describe, expect, it, vi } from "vitest";
import { exec as shellExec } from "node:child_process";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const { acquire } = vi.hoisted(() => ({ acquire: vi.fn() }));
vi.mock("@repo/platform/engine/lib/ssh-manager", () => ({ sshManager: { acquire } }));
vi.mock("@repo/platform/engine/lib/ssh-tunnel", () => ({
  tunnelRequest: vi.fn(),
  tunnelStream: vi.fn(),
}));
vi.mock("@repo/platform/engine/lib/platform-mode", () => ({
  isOblienBackedDeployment: async () => false,
}));
vi.mock("@repo/adapters", async (original) => ({
  ...(await original<typeof import("@repo/adapters")>()),
  resolveOurEdgeContainer: async () => "fixture-edge",
}));

const { postEdgeMgmt } = await import("@repo/platform/engine/lib/project-analytics");
const exec = promisify(shellExec);
let server: Server | undefined;
let directory: string | undefined;
const files: string[] = [];
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
  for (const file of files.splice(0)) await rm(file, { force: true });
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("large edge management requests", () => {
  it("delivers literal JSON through real curl without shell expansion or oversized arguments", async () => {
    directory = await mkdtemp(join(tmpdir(), "openship-response-transport-"));
    const marker = join(directory, "must-not-execute");
    const literal = `'; touch ${marker}; $(touch ${marker}) \`touch ${marker}\`\nمرحبا\u0000`;
    const payload = {
      host: "response.test",
      rules: Array.from({ length: 4 }, (_, i) => ({
        pathPrefix: `/response/${i}`,
        spec: { response: { body: literal + "x".repeat(64000) } },
      })),
    };
    let received = "";
    server = createServer(async (request, response) => {
      for await (const chunk of request) received += chunk.toString();
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ ok: true, count: 4 }));
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture port");
    acquire.mockResolvedValue({
      writeFile: async (path: string, body: string, options: { mode: number }) => {
        files.push(path);
        await writeFile(path, body, options);
        expect((await stat(path)).mode & 0o777).toBe(0o600);
      },
      rm: (path: string) => rm(path, { force: true }),
      exec: async (command: string) => {
        // Simulate Linux's single-argument ceiling even when this test runs on
        // macOS. Only Docker isolation is elided: curl, shell, files and HTTP
        // are real, and the fixture shares its request file with the host.
        if (Buffer.byteLength(command) >= 128 * 1024) throw new Error("E2BIG");
        if (command.startsWith("docker cp ")) return "";
        const prefix = "docker exec 'fixture-edge' ";
        if (!command.startsWith(prefix)) throw new Error("Unexpected fixture command");
        const local = command
          .slice(prefix.length)
          .replace("127.0.0.1:9145", `127.0.0.1:${address.port}`);
        return (await exec(local)).stdout;
      },
    });
    await expect(postEdgeMgmt("fixture-server", "/rules", payload)).resolves.toEqual({
      ok: true,
      count: 4,
    });
    expect(JSON.parse(received)).toEqual(payload);
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
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
