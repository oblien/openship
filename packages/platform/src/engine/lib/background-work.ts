import { reportError, type ErrorContext } from "@repo/core/diagnostics";
import { currentErrorContext, withErrorContext } from "@repo/core/diagnostics/node";
import { createTaskGroup } from "../../state/task-group";

// One group per engine owner (the API process or an owned native worker).
const tasks = createTaskGroup();
export function trackBackgroundWork<T>(work: Promise<T>, context: ErrorContext = {}): Promise<T> {
  const snapshot = { ...currentErrorContext(), ...context };
  void work.catch(error => reportError(error, { ...snapshot, kind: "background", handled: true }));
  return tasks.track(work);
}
export const drainBackgroundWork = tasks.drain;

/** Register ownership before yielding, so an immediate close cannot miss deferred work. */
export function deferBackgroundWork<T>(work: () => Promise<T>): Promise<T> {
  const context = currentErrorContext();
  return trackBackgroundWork(new Promise<void>(resolve => setImmediate(resolve)).then(() => withErrorContext(context, work)));
}
