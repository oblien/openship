import { createTaskGroup } from "../../state/task-group";

// One group per engine owner (the API process or an owned native worker).
const tasks = createTaskGroup();
export const trackBackgroundWork = tasks.track;
export const drainBackgroundWork = tasks.drain;

/** Register ownership before yielding, so an immediate close cannot miss deferred work. */
export function deferBackgroundWork<T>(work: () => Promise<T>): Promise<T> {
  return tasks.track(new Promise<void>(resolve => setImmediate(resolve)).then(work));
}
