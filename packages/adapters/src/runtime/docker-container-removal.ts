import type Dockerode from "dockerode";
import { setTimeout as delay } from "node:timers/promises";
import { isRuntimeNotFoundError } from "../system/errors";

/** Docker's one retryable removal conflict. Other 409s remain real failures. */
export function isDockerRemovalInProgress(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { statusCode?: number; status?: number; message?: string };
  return (
    (value.statusCode ?? value.status) === 409 &&
    typeof value.message === "string" &&
    /removal of container .+ is already in progress/i.test(value.message)
  );
}

/** Docker owns the image's stop signal and configured/default grace period.
 * A failed graceful stop is never permission to force-kill a live database. */
export async function gracefulStopBeforeRemoval(
  container: Dockerode.Container,
  signal?: AbortSignal,
): Promise<void> {
  try {
    if (signal) await container.stop({ abortSignal: signal });
    else await container.stop();
  } catch (error) {
    if (
      (error as { statusCode?: number } | null)?.statusCode !== 304 &&
      !isRuntimeNotFoundError(error)
    )
      throw error;
  }
}

/** Removal can outlive the caller's teardown ceiling. Join that operation by
 * exact ID; never delete or inspect a successor that reused the old name. */
export async function removeDockerContainer(
  docker: Pick<Dockerode, "getContainer">,
  reference: string,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    assertAccess?: (containerId: string) => Promise<void>;
  } = {},
): Promise<void> {
  let timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error("Container removal requires a positive timeout.");
  options.signal?.throwIfAborted();
  const deadline = new AbortController();
  const expire = () =>
    deadline.abort(
      new Error(
        `Container removal did not finish within ${timeoutMs}ms; the old container's removal is still unconfirmed.`,
      ),
    );
  let timer = setTimeout(expire, timeoutMs);
  timer.unref?.();
  const signal = options.signal
    ? AbortSignal.any([options.signal, deadline.signal])
    : deadline.signal;
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  const request = <T>(work: () => Promise<T>): Promise<T> => {
    signal.throwIfAborted();
    // Some older socket/bridge transports ignore abortSignal. Still bound how
    // long this worker waits; Docker may finish its accepted remove afterward.
    return Promise.race([aborted, work()]);
  };
  try {
    let inspected: Dockerode.ContainerInspectInfo;
    try {
      inspected = await request(() =>
        docker.getContainer(reference).inspect({ abortSignal: signal }),
      );
    } catch (error) {
      if (isRuntimeNotFoundError(error)) return;
      throw error;
    }
    if (!/^[a-f0-9]{64}$/.test(inspected.Id ?? ""))
      throw new Error("Cannot verify the exact container identity before removal.");
    const id = inspected.Id;
    // A configured graceful shutdown may take longer than the removal wait.
    // Preserve that allowance; only an explicit caller deadline overrides it.
    const graceMs =
      Number((inspected.Config as { StopTimeout?: number } | undefined)?.StopTimeout ?? 0) * 1_000;
    if (options.timeoutMs === undefined && Number.isFinite(graceMs) && graceMs > 0) {
      timeoutMs += graceMs;
      clearTimeout(timer);
      timer = setTimeout(expire, Math.min(timeoutMs, 2_147_483_647));
      timer.unref?.();
    }
    await request(async () => options.assertAccess?.(id));
    const container = docker.getContainer(id);
    if (inspected.State?.Status !== "removing") {
      try {
        await request(() => gracefulStopBeforeRemoval(container, signal));
        await request(() => container.remove({ force: true, abortSignal: signal }));
      } catch (error) {
        if (isRuntimeNotFoundError(error)) return;
        if (!isDockerRemovalInProgress(error)) throw error;
      }
    }
    while (true) {
      try {
        await request(() => container.inspect({ abortSignal: signal }));
      } catch (error) {
        if (isRuntimeNotFoundError(error)) return;
        throw error;
      }
      await delay(250, undefined, { signal });
    }
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}
