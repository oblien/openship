/**
 * Safe WebSocket / Shell operation helpers.
 * Swallows expected "peer gone" / "already closing" errors so callers
 * don't need try/catch noise at every call site.
 */

export interface WSLike {
  send(data: string | ArrayBufferLike | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export interface ShellLike {
  stdin: { write(buf: Buffer): void };
  close(): void;
}

/** Send data on a WebSocket. Ignores "peer gone" errors. */
export function safeWsSend(ws: WSLike, data: string | ArrayBufferLike | Uint8Array): void {
  try {
    ws.send(data);
  } catch {
    /* peer gone */
  }
}

/** Close a WebSocket. Ignores "already closing" errors. */
export function safeWsClose(ws: WSLike, code: number, reason?: string): void {
  try {
    ws.close(code, reason);
  } catch {
    /* already closing */
  }
}

/** Write to a shell stdin. Ignores "shell gone" errors. */
export function safeShellWrite(shell: ShellLike, buf: Buffer): void {
  try {
    shell.stdin.write(buf);
  } catch {
    /* shell gone */
  }
}

/** Close a shell. Best-effort, ignores errors. */
export function safeShellClose(shell: ShellLike): void {
  try {
    shell.close();
  } catch {
    /* best-effort */
  }
}