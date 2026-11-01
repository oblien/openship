import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { TERMINAL_COLS_MAX, TERMINAL_ROWS_MAX, type TerminalTarget } from "@repo/contracts";
import type { TerminalSession } from "@repo/sdk/client";
import { getRemoteClient } from "./ship-client";
import { getDashboardUrl } from "./config";
import { isJsonMode } from "./output";

export async function openTerminal(
  target: TerminalTarget,
  options: { origin?: string; timeout?: number },
): Promise<void> {
  const input = process.stdin;
  const output = process.stdout;
  if (!input.isTTY || !output.isTTY || isJsonMode())
    throw new Error(
      "An interactive terminal is required. Use server exec or service exec for scripts and --json output.",
    );
  const client = getRemoteClient();
  const origin = new URL(options.origin ?? getDashboardUrl());
  if (!["https:", "http:"].includes(origin.protocol) || origin.username || origin.password)
    throw new Error("Use an HTTP(S) dashboard origin for this instance.");

  const abort = new AbortController();
  const wasRaw = input.isRaw;
  const wasPaused = input.isPaused();
  let session: TerminalSession | undefined;
  let interrupted = false;
  const stop = (code: number) => {
    interrupted = true;
    process.exitCode = code;
    abort.abort(new Error("Terminal interrupted"));
  };
  const sigint = () => stop(130);
  const sigterm = () => stop(143);
  const sighup = () => stop(129);
  const onInput = (data: Buffer) => {
    try {
      session?.write(data);
    } catch (error) {
      observeCaughtError(error, "cli/lib/terminal");
      abort.abort(error);
    }
  };
  const onResize = () => {
    try {
      session?.resize(
        Math.max(1, Math.min(output.columns || 80, TERMINAL_COLS_MAX)),
        Math.max(1, Math.min(output.rows || 24, TERMINAL_ROWS_MAX)),
      );
    } catch (error) {
      observeCaughtError(error, "cli/lib/terminal");
      abort.abort(error);
    }
  };
  const onEnd = () => session?.close();
  process.on("SIGINT", sigint);
  process.on("SIGTERM", sigterm);
  process.on("SIGHUP", sighup);
  try {
    const settings = {
      onData: (data: Uint8Array) => {
        output.write(data);
      },
      signal: abort.signal,
      connectTimeoutMs: options.timeout,
      origin: origin.origin,
    };
    session =
      target.kind === "server"
        ? await client.terminal.openServer(target.id, settings)
        : await client.terminal.openService(target.id, settings);
    onResize();
    input.setRawMode(true);
    input.on("data", onInput);
    input.on("end", onEnd);
    output.on("resize", onResize);
    input.resume();
    const result = await session.closed;
    process.exitCode =
      result.code === null
        ? result.signal && result.signal !== "client_close"
          ? 1
          : 0
        : result.code >= 0 && result.code <= 255
          ? result.code
          : 1;
  } catch (error) {
    if (!interrupted) throw error;
  } finally {
    input.removeListener("data", onInput);
    input.removeListener("end", onEnd);
    output.removeListener("resize", onResize);
    process.removeListener("SIGINT", sigint);
    process.removeListener("SIGTERM", sigterm);
    process.removeListener("SIGHUP", sighup);
    try {
      input.setRawMode(wasRaw);
    } finally {
      if (wasPaused) input.pause();
      session?.close();
    }
  }
}
