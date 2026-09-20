/** Leave a command through the root's finally block so owned workers can drain. */
export class CommandExit extends Error {
  constructor(readonly code: number) { super(`Command exited (${code})`); }
}

export function exitCommand(code = 0): never { throw new CommandExit(code); }
export function rethrowCommandExit(error: unknown): void {
  if (error instanceof CommandExit) throw error;
}
