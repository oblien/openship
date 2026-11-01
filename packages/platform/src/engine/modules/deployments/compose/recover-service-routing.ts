import type { CommandExecutor } from "@repo/adapters";

/** Restore both routing views without leaving a writer behind after a timeout. */
export async function recoverServiceRouting(
  reapplyProjectRoutes: () => Promise<void>,
  applyTopologyRoutes: () => Promise<void>,
  executor?: Pick<CommandExecutor, "runWithAbortSignal"> | null,
): Promise<void> {
  const recovery = new AbortController();
  const timeout = setTimeout(
    () => recovery.abort(new Error("Previous service routing recovery timed out")),
    30_000,
  );
  const restore = async () => {
    recovery.signal.throwIfAborted();
    await reapplyProjectRoutes();
    recovery.signal.throwIfAborted();
    await applyTopologyRoutes();
    recovery.signal.throwIfAborted();
  };
  try {
    // The deadline requests cancellation of executor commands. A queued lock or
    // other uncancellable route pass must still settle before this attempt gives
    // up execution ownership; abandoning it can overwrite a later retry's routes.
    await (executor?.runWithAbortSignal
      ? executor.runWithAbortSignal(recovery.signal, restore)
      : restore());
  } catch (error) {
    if (recovery.signal.aborted) throw recovery.signal.reason;
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
