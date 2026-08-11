import type { Duplex } from "node:stream";
import { waitForReady, type CommandExecutor } from "@repo/adapters";

interface ReadinessOptions {
  path?: string;
  timeoutMs?: number;
  intervalMs?: number;
  probeTimeoutMs?: number;
  acceptStatusBelow?: number;
}

type PortForwarder = (host: string, port: number) => Promise<Duplex>;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function openForward(
  forward: PortForwarder,
  host: string,
  port: number,
  timeoutMs: number,
): Promise<Duplex | null> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      resolve(null);
    }, timeoutMs);
    timer.unref?.();

    forward(host, port).then(
      (stream) => {
        if (settled) {
          stream.destroy();
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(stream);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

function probeHttpStream(
  stream: Duplex,
  host: string,
  port: number,
  path: string,
  timeoutMs: number,
  acceptStatusBelow: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let received = "";
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    timer.unref?.();

    stream.on("data", (chunk) => {
      received += chunk.toString("latin1");
      const lineEnd = received.indexOf("\r\n");
      if (lineEnd < 0) {
        if (received.length > 8_192) done(false);
        return;
      }
      const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})\b/.exec(received.slice(0, lineEnd));
      const status = match ? Number(match[1]) : 0;
      done(status > 0 && status < acceptStatusBelow);
    });
    stream.once("error", () => done(false));
    stream.once("end", () => done(false));

    if (!path.startsWith("/") || /[\r\n]/.test(path)) {
      done(false);
      return;
    }
    stream.write(`GET ${path} HTTP/1.1\r\nHost: ${host}:${port}\r\nConnection: close\r\n\r\n`);
  });
}

/** Poll readiness from the machine represented by an SSH direct-tcpip channel. */
export async function waitForForwardedReady(
  forward: PortForwarder,
  host: string,
  port: number,
  opts: ReadinessOptions = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const intervalMs = opts.intervalMs ?? 1_000;
  const probeTimeoutMs = opts.probeTimeoutMs ?? 2_500;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    const stream = await openForward(forward, host, port, Math.min(probeTimeoutMs, remaining));
    if (stream) {
      if (!opts.path) {
        stream.destroy();
        return true;
      }
      if (
        await probeHttpStream(
          stream,
          host,
          port,
          opts.path,
          Math.min(probeTimeoutMs, Math.max(1, deadline - Date.now())),
          opts.acceptStatusBelow ?? 500,
        )
      ) {
        return true;
      }
    }
    const waitMs = Math.min(intervalMs, deadline - Date.now());
    if (waitMs <= 0) return false;
    await delay(waitMs);
  }
}

/** Use host forwarding when available, with direct sockets for LocalExecutor. */
export function waitForReadyFromExecutor(
  executor: CommandExecutor,
  host: string,
  port: number,
  opts: ReadinessOptions = {},
): Promise<boolean> {
  return executor.forwardPort
    ? waitForForwardedReady(executor.forwardPort.bind(executor), host, port, opts)
    : waitForReady(host, port, opts);
}
