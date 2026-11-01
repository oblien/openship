import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { openCloudflareSshStream } from "./cloudflare-ssh";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

function mockProxy() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    kill: vi.fn(),
  });
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  return child;
}

describe("Cloudflare SSH subprocess stream ordering", () => {
  beforeEach(() => vi.stubEnv("OPENSHIP_CLOUDFLARED_PATH", process.execPath));
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it.each(["close", "EPIPE"])("preserves Access diagnostics when stdin reports %s before process close", async (event) => {
    const child = mockProxy();
    const stream = openCloudflareSshStream("ssh.example.test");
    const errors: Error[] = [];
    stream.on("error", (error) => errors.push(error));
    try {
      child.stdout.end();
      child.stdin.destroy(event === "EPIPE" ? new Error("write EPIPE") : undefined);
      await setImmediate();
      expect(stream.destroyed).toBe(false);
      expect(errors).toEqual([]);

      child.stderr.write("Access policy denied this account\n");
      child.stderr.end();
      child.exitCode = 1;
      const closed = new Promise<void>((resolve) => stream.once("close", resolve));
      child.emit("close", 1, null);
      await closed;
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain("Cloudflare Access connection failed: Access policy denied this account");
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      stream.destroy();
    }
  });

  it("terminates the proxy when its SSH consumer closes the stream", async () => {
    const child = mockProxy();
    const stream = openCloudflareSshStream("ssh.example.test");
    const closed = new Promise<void>((resolve) => stream.once("close", resolve));
    stream.destroy();
    await closed;
    expect(child.kill).toHaveBeenCalledTimes(1);
  });
});
