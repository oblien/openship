import type { Context } from "hono";
import type { OperationResult } from "@repo/platform";
import type { DeploymentEvent } from "@repo/contracts";
import { streamSSE } from "./sse";
import { operationData } from "./operation-context";

/** Authorize/open before headers, then close the shared source on HTTP disconnect. */
export async function operationEvents(
  c: Context,
  open: (signal: AbortSignal) => Promise<OperationResult<AsyncIterable<DeploymentEvent>>>,
) {
  const abort = new AbortController();
  const requestSignal = c.req.raw?.signal;
  const disconnected = () => abort.abort();
  requestSignal?.addEventListener("abort", disconnected, { once: true });
  if (requestSignal?.aborted) disconnected();
  try {
    const source = await operationData(c, open(abort.signal));
    return streamSSE(c, async stream => {
      stream.onAbort(disconnected);
      try {
        for await (const event of source) await stream.writeSSE(event);
      } catch (error) {
        if (!abort.signal.aborted) throw error;
      } finally {
        disconnected();
        requestSignal?.removeEventListener("abort", disconnected);
      }
    });
  } catch (error) {
    disconnected();
    requestSignal?.removeEventListener("abort", disconnected);
    throw error;
  }
}
