import { execFile, spawn } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Generic reverse tunnel over the OS `ssh` binary — the system-ssh (agent-auth)
 * counterpart to `SshExecutor.reverseForward` (ssh2). Reusable by any consumer
 * that needs "the remote reaches back to this host": the git-credential relay
 * today, and future features (server→host callbacks, remote probes, …).
 *
 * Mechanism: a loopback listener is opened here; then `ssh -O forward -R
 * 127.0.0.1:0:127.0.0.1:<local>` asks the EXISTING ControlMaster to bind a
 * dynamic remote loopback port that forwards back to the listener. OpenSSH
 * prints the allocated remote port to stdout, so no stderr parsing or fixed-port
 * guessing is needed, and it reuses the already-authenticated master (no second
 * auth). `-O cancel` removes the forward on close. The master must be up first
 * (caller awaits `ensureMaster`).
 *
 * Each remote connection to the bound port arrives as a `net.Socket` (a Duplex)
 * and is handed to `onConnection`.
 */
export interface ReverseTunnelOptions {
  /** Base `ssh` args that select the ControlMaster (from `buildBaseSshArgs`). */
  baseArgs: string[];
  /** `user@host` target. */
  target: string;
  /** Child env (from `sshChildEnv` — carries SSH_AUTH_SOCK). */
  env: NodeJS.ProcessEnv;
  /** Called with each inbound duplex stream from the remote. */
  onConnection: (stream: Duplex) => void;
  /** ssh binary to invoke. Overridable for tests; defaults to `ssh`. */
  sshBin?: string;
  /** Windows OpenSSH uses a dedicated foreground process instead of -O. */
  multiplex?: boolean;
}

export async function openSystemSshReverseTunnel(
  opts: ReverseTunnelOptions,
): Promise<{ port: number; close: () => Promise<void> }> {
  // 1. Loopback listener on an OS-assigned local port.
  const sockets = new Set<Duplex>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    opts.onConnection(socket);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const localPort = (server.address() as AddressInfo).port;
  server.on("error", () => {});
  const closeServer = () => new Promise<void>((resolve) => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    server.close(() => resolve());
  });
  const sshBin = opts.sshBin ?? "ssh";

  // 2. Ask the master to bind a dynamic remote loopback port. `-O forward -R`
  //    with listen-port 0 prints the allocated port to stdout.
  const forwardSpec = (remote: number) => `127.0.0.1:${remote}:127.0.0.1:${localPort}`;
  if (opts.multiplex === false) {
    const child = spawn(sshBin, ["-o", "LogLevel=DEBUG1", ...opts.baseArgs, "-N", "-o", "ExitOnForwardFailure=yes", "-R", forwardSpec(0), opts.target], {
      env: opts.env, windowsHide: true, stdio: ["ignore", "ignore", "pipe"],
    });
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      child.kill();
      await closeServer();
    };
    try {
      const port = await new Promise<number>((resolve, reject) => {
        let stderr = "";
        let settled = false;
        const finish = (error?: Error, port?: number) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error) reject(error); else resolve(port!);
        };
        const timer = setTimeout(() => finish(new Error("SSH reverse tunnel timed out before the server allocated a port.")), 30_000);
        child.stderr.on("data", (chunk: Buffer) => {
          stderr = (stderr + chunk.toString()).slice(-8192);
          // OpenSSH reports this after the server acknowledges dynamic -R.
          const port = Number(stderr.match(/Allocated port (\d+) for remote forward to/)?.[1]);
          if (Number.isInteger(port) && port > 0 && port <= 65535) finish(undefined, port);
        });
        child.on("error", error => finish(error));
        child.once("close", code => {
          finish(new Error(`SSH reverse tunnel closed (${code}): ${stderr.trim()}`));
          void close();
        });
      });
      return { port, close };
    } catch (error) {
      await close();
      throw error;
    }
  }
  let remotePort: number;
  try {
    const { stdout } = await execFileAsync(
      sshBin,
      [...opts.baseArgs, "-O", "forward", "-R", forwardSpec(0), opts.target],
      { env: opts.env, timeout: 30_000 },
    );
    remotePort = Number.parseInt(stdout.trim(), 10);
    if (!Number.isInteger(remotePort) || remotePort <= 0) {
      throw new Error(`ssh -O forward returned no port (stdout: ${JSON.stringify(stdout.trim())})`);
    }
  } catch (err) {
    await closeServer();
    throw err;
  }

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    // Best-effort: remove the remote forward from the master, then close the
    // local listener. A dead master makes cancel a no-op, which is fine.
    await execFileAsync(
      sshBin,
      [...opts.baseArgs, "-O", "cancel", "-R", forwardSpec(remotePort), opts.target],
      { env: opts.env, timeout: 5_000 },
    ).catch(() => {});
    await closeServer();
  };

  return { port: remotePort, close };
}
