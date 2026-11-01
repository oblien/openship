import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter, once } from "node:events";
import { PassThrough, type Duplex } from "node:stream";
import { connect } from "node:net";
import { buildBaseSshArgs } from "./system-ssh";
import { SystemSshExecutor } from "./system-ssh-executor";

const processes = vi.hoisted(() => ({ spawned: [] as Array<{ args: string[]; child: FakeChild }>, execFile: vi.fn() }));
class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  kill = vi.fn(() => {
    this.stdin.destroy(); this.stdout.destroy(); this.stderr.destroy();
    this.emit("exit", null, "SIGTERM"); this.emit("close", null);
    return true;
  });
}
vi.mock("node:child_process", () => ({
  execFile: processes.execFile,
  spawn: (_binary: string, args: string[]) => {
    const child = new FakeChild();
    processes.spawned.push({ args, child });
    return child;
  },
}));
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "win32" });
  processes.spawned.length = 0;
  processes.execFile.mockClear();
});
afterEach(() => Object.defineProperty(process, "platform", platform));

describe("Windows OpenSSH without Unix ControlMaster", () => {
  const config = { host: "ssh.example.test", username: "root", useSystemSsh: true };

  it("disables control sockets on Windows while retaining multiplexing on Unix", () => {
    const windows = buildBaseSshArgs(config, "/tmp/master.sock", "win32");
    expect(windows).toContain("ControlMaster=no");
    expect(windows).toContain("ControlPath=none");
    expect(windows.join(" ")).not.toContain("/tmp/");
    expect(buildBaseSshArgs(config, "/tmp/master.sock", "linux")).toContain("ControlPath=/tmp/master.sock");
  });

  it("executes without attempting -fN or -O and disposes live processes", async () => {
    const executor = new SystemSshExecutor(config);
    expect(executor.persistentConnection).toBe(false);
    const result = executor.exec("echo ok");
    await vi.waitFor(() => expect(processes.spawned).toHaveLength(1));
    const { child, args } = processes.spawned[0]!;
    child.stdout.write("ok\n"); child.emit("close", 0);
    expect(await result).toBe("ok");
    expect(args).not.toContain("-fN"); expect(args).not.toContain("-O");
    expect(processes.execFile).not.toHaveBeenCalled();
    const docker = await executor.openDockerDialStdio();
    const pending = processes.spawned.at(-1)!;
    expect(pending.args.at(-1)).toBe("docker system dial-stdio");
    const response = once(docker, "data");
    pending.child.stdout.write("HTTP/1.1 200 OK\r\n\r\n");
    expect((await response)[0].toString()).toContain("200 OK");
    await executor.dispose();
    expect(pending.child.kill).toHaveBeenCalled();
    await expect(executor.exec("true")).rejects.toThrow(/disposed/);
  });

  it("uses the foreground reverse tunnel and closes it with the executor", async () => {
    const executor = new SystemSshExecutor(config);
    const incoming = vi.fn((stream: Duplex) => stream.end("credential-relay"));
    const opening = executor.reverseForward(incoming);
    await vi.waitFor(() => expect(processes.spawned).toHaveLength(1));
    const { child, args } = processes.spawned[0]!;
    expect(args).not.toContain("-O");
    child.stderr.write("debug1: Allocated port 43123 for remote forward to 127.0.0.1\n");
    const tunnel = await opening;
    expect(tunnel.port).toBe(43123);
    const localPort = Number(args[args.indexOf("-R") + 1]!.split(":").at(-1));
    const client = connect(localPort, "127.0.0.1");
    expect((await once(client, "data"))[0].toString()).toBe("credential-relay");
    client.destroy();
    await executor.dispose();
    expect(child.kill).toHaveBeenCalledOnce();
    await tunnel.close();
  });

  it("surfaces reverse-forward failures and releases the process", async () => {
    const executor = new SystemSshExecutor(config);
    const opening = executor.reverseForward(() => {});
    const rejection = expect(opening).rejects.toThrow(/forwarding failed/);
    await vi.waitFor(() => expect(processes.spawned).toHaveLength(1));
    const { child } = processes.spawned[0]!;
    child.stderr.write("remote port forwarding failed\n");
    child.emit("close", 255);
    await rejection;
    expect(child.kill).toHaveBeenCalled();
    await executor.dispose();
  });
});
