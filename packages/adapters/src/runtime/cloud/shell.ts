import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { PassThrough, Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import type { Runtime } from "oblien";
import type { ManagedCommandRef } from "@repo/core";
import type { ShellOptions, ShellSession } from "../../types";
import { currentManagedCommandTracking } from "./command-tracking";
import { recoverManagedCommand } from "./command-recovery";
import { CLOUD_TERMINAL_SHELL } from "./exec-framing";

/** Shared provider PTY adapter for service and managed-server terminals. */
export async function openCloudShell(rt: Runtime, opts?: ShellOptions, workspaceId?: string,
  recoveryRuntime: () => Promise<Runtime> = async () => rt): Promise<ShellSession> {
  const cols = clampShellWindow(opts?.cols, 80, 1000);
  const rows = clampShellWindow(opts?.rows, 24, 500);
  const tracking = currentManagedCommandTracking();
  if (tracking && !workspaceId) throw new Error("Managed terminal is missing its server identity");
  const command: ManagedCommandRef = { workspaceId: workspaceId ?? "", marker: `openship-exec-${randomUUID()}:`, kind: "terminal" };
  await tracking?.record(command);
  let terminalId: string;
  try {
    const session = await rt.terminal.create({ cmd: ["python3", "-u", "-c", CLOUD_TERMINAL_SHELL, command.marker], cols, rows });
    if (typeof session.id !== "string" || !session.id) throw new Error("The server returned no terminal identity");
    terminalId = session.id;
    command.terminalId = terminalId;
    await tracking?.record({ ...command });
  } catch (error) {
    await recoverManagedCommand(await recoveryRuntime(), command);
    await tracking?.complete(command.marker);
    throw error;
  }
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const listeners = new Set<(code: number | null, signal?: string) => void>();
  let exit: { code: number | null; signal?: string } | null = null;
  let cleanup: Promise<void> | undefined;
  let socket: ReturnType<Runtime["ws"]> | undefined;
  let rejectOpen: (error: Error) => void = () => {};

  stdout.on("error", () => {
    void finish().catch((diagnosticFailure) => {
      observeCaughtError(diagnosticFailure, "adapters/runtime/cloud/shell");
    });
  });
  stderr.on("error", () => {
    void finish().catch((diagnosticFailure) => {
      observeCaughtError(diagnosticFailure, "adapters/runtime/cloud/shell");
    });
  });
  stdout.on("close", () => {
    void finish().catch((diagnosticFailure) => {
      observeCaughtError(diagnosticFailure, "adapters/runtime/cloud/shell");
    });
  });
  stderr.on("close", () => {
    void finish().catch((diagnosticFailure) => {
      observeCaughtError(diagnosticFailure, "adapters/runtime/cloud/shell");
    });
  });

  function finish(code: number | null = null, signal?: string): Promise<void> {
    if (exit) return cleanup ?? Promise.resolve();
    exit = { code, signal };
    cleanup = recoveryRuntime().then(fresh => recoverManagedCommand(fresh, command)).then(() => tracking?.complete(command.marker));
    rejectOpen(new Error("The server terminal connection closed before it was ready"));
    try {
      socket?.close();
    } catch (diagnosticFailure) {
      observeCaughtError(diagnosticFailure, "adapters/runtime/cloud/shell");
      /* socket already gone */
    }
    stdout.end();
    stderr.end();
    for (const listener of listeners) {
      try {
        listener(code, signal);
      } catch (diagnosticFailure) {
        observeCaughtError(diagnosticFailure, "adapters/runtime/cloud/shell");
        /* isolate subscriber failures */
      }
    }
    listeners.clear();
    return cleanup;
  }

  try {
    socket = rt.ws({ reconnect: false });
    const ws = socket;
    ws.onTerminalOutput((id, bytes) => {
      if (id !== terminalId || exit) return;
      // No flow-control method exists in the provider socket. Bound output while
      // the consumer attaches or stalls instead of buffering indefinitely.
      if (stdout.readableLength + stdout.writableLength + bytes.byteLength > 1024 * 1024) {
        void finish(null, "output_overflow").catch((diagnosticFailure) => {
          observeCaughtError(diagnosticFailure, "adapters/runtime/cloud/shell");
        });
        return;
      }
      stdout.write(Buffer.from(bytes));
    });
    ws.onTerminalExit((id, code) => {
      if (id === terminalId) void finish(code ?? null).catch((diagnosticFailure) => {
        observeCaughtError(diagnosticFailure, "adapters/runtime/cloud/shell");
      });
    });
    ws.onClose(() => {
      void finish().catch((diagnosticFailure) => {
        observeCaughtError(diagnosticFailure, "adapters/runtime/cloud/shell");
      });
    });
    ws.onError(() => {
      void finish().catch((diagnosticFailure) => {
        observeCaughtError(diagnosticFailure, "adapters/runtime/cloud/shell");
      });
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        rejectOpen = reject;
        ws.onOpen(resolve);
        timeout = setTimeout(
          () => reject(new Error("The server terminal connection timed out")),
          15_000,
        );
        ws.connect();
      });
      if (exit) throw new Error("The server terminal connection closed before it was ready");
    } finally {
      clearTimeout(timeout);
    }

    const stdin = new Writable({
      write(chunk, _encoding, callback) {
        if (exit) {
          callback(new Error("The server terminal is closed"));
          return;
        }
        try {
          ws.writeTerminalInput(terminalId, chunk);
          callback();
        } catch (error) {
          observeCaughtError(error, "adapters/runtime/cloud/shell");
          callback(error instanceof Error ? error : new Error("Terminal input failed"));
        }
      },
      final(callback) {
        void finish().then(() => callback(), error => { /* diagnostics-ignore: The Writable callback propagates the failure to the consumer. */ return callback(error); });
      },
    });
    stdin.on("error", () => {
      void finish().catch((diagnosticFailure) => {
        observeCaughtError(diagnosticFailure, "adapters/runtime/cloud/shell");
      });
    });
    return {
      stdin,
      stdout,
      stderr,
      setWindow(c, r) {
        if (exit) return;
        try {
          ws.resizeTerminal(
            terminalId,
            clampShellWindow(c, 80, 1000),
            clampShellWindow(r, 24, 500),
          );
        } catch (diagnosticFailure) {
          observeCaughtError(diagnosticFailure, "adapters/runtime/cloud/shell");
          void finish().catch((diagnosticFailure) => {
            observeCaughtError(diagnosticFailure, "adapters/runtime/cloud/shell");
          });
        }
      },
      close: async () => {
        await finish();
      },
      onClose(listener) {
        if (exit) listener(exit.code, exit.signal);
        else listeners.add(listener);
      },
    };
  } catch (error) {
    await finish();
    throw error;
  }
}

function clampShellWindow(value: number | undefined, fallback: number, max: number): number {
  return Math.max(1, Math.min(max, Math.floor(Number.isFinite(value) ? value! : fallback)));
}
