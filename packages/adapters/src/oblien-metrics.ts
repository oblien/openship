import { parseSSEChunks } from "@repo/core";

class MetricsStreamFailure extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

async function retryPause(delay: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const done = () => {
      signal?.removeEventListener("abort", cancel);
      resolve();
    };
    const cancel = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      reject(signal!.reason);
    };
    const timer = setTimeout(done, delay);
    timer.unref?.();
    signal?.addEventListener("abort", cancel, { once: true });
  });
}

/** A metrics subscription owns its fetch and reader. Bound stalled connections
 * and incomplete frames without changing the SDK's other SSE operations. */
export async function* workspaceMetricsStream(
  open: (signal: AbortSignal) => Promise<Response>,
  signal?: AbortSignal,
): AsyncGenerator<unknown> {
  let failures = 0;
  for (;;) {
    const startedAt = Date.now();
    let received = false;
    try {
      for await (const sample of readMetricsConnection(open, signal)) {
        received = true;
        yield sample;
      }
      throw new MetricsStreamFailure("Live resource usage disconnected. Retry to reconnect.", true);
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof MetricsStreamFailure && !error.retryable) throw error;
      // A sustained, healthy subscription earns a fresh retry budget. One frame
      // followed by failure must not turn into an endless rapid reconnect loop.
      if (received && Date.now() - startedAt >= 30_000) failures = 0;
      if (failures >= 3) throw error;
      await retryPause(1000 * 2 ** failures++, signal);
    }
  }
}

async function* readMetricsConnection(
  open: (signal: AbortSignal) => Promise<Response>,
  signal?: AbortSignal,
): AsyncGenerator<unknown> {
  const abort = new AbortController();
  const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
  let deadline: ReturnType<typeof setTimeout>;
  const arm = () => {
    clearTimeout(deadline);
    deadline = setTimeout(
      () => abort.abort(new MetricsStreamFailure("Live usage stream timed out")),
      45_000,
    );
    deadline.unref?.();
  };
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  arm();
  try {
    combined.throwIfAborted();
    const response = await open(combined);
    if (
      !response.ok ||
      !response.body ||
      !response.headers.get("content-type")?.includes("text/event-stream")
    ) {
      await response.body?.cancel();
      throw new MetricsStreamFailure(
        "Live resource usage is unavailable. Retry to reconnect.",
        [408, 429, 500, 502, 503, 504].includes(response.status),
      );
    }
    reader = response.body.getReader();
    let frameBytes = 0;
    const chunks = {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          const chunk = await reader!.read();
          if (chunk.done) return;
          arm();
          frameBytes += chunk.value.byteLength;
          if (frameBytes > 65_536)
            throw new MetricsStreamFailure("Invalid live resource usage response");
          yield chunk.value;
        }
      },
    };
    for await (const event of parseSSEChunks(chunks)) {
      combined.throwIfAborted();
      frameBytes = 0;
      if (event.event === "error")
        throw new MetricsStreamFailure(
          "Live resource usage is unavailable. Retry to reconnect.",
          true,
        );
      let sample: unknown;
      try {
        sample = JSON.parse(event.data);
      } catch {
        throw new MetricsStreamFailure("Invalid live resource usage response");
      }
      yield sample;
    }
  } catch (error) {
    if (abort.signal.aborted) throw abort.signal.reason;
    throw error;
  } finally {
    clearTimeout(deadline!);
    abort.abort();
    if (reader) {
      try {
        await reader.cancel();
      } catch {
        /* diagnostics-ignore: cancellation only releases this read-only subscription. */
      }
      reader.releaseLock();
    }
  }
}
