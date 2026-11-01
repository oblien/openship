import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import type { DeploymentEvent } from "@repo/contracts";
import { fail } from "./cmd-helpers";
import { isJsonMode, printJsonLine } from "./output";

/** Preserve event payloads in automation; errors in a successful SSE response still fail. */
export async function printEvents(
  events: AsyncIterable<DeploymentEvent>,
  completion?: {
    event: string;
    successful: (data: unknown) => boolean;
  },
): Promise<void> {
  try {
    for await (const event of events) {
      if (event.event === "ping") continue;
      let data: unknown = event.data;
      try {
        data = JSON.parse(event.data);
      } catch {
        /* Plain-text log events are valid. */
      }
      if (isJsonMode()) printJsonLine({ event: event.event, data });
      else
        process.stdout.write(
          `${event.event}: ${typeof data === "string" ? data : JSON.stringify(data)}\n`,
        );
      if (event.event === "error") {
        const message =
          data && typeof data === "object" && "error" in data ? String(data.error) : event.data;
        throw new Error(message || "The event stream reported an error.");
      }
      if (completion && event.event === completion.event) {
        if (!completion.successful(data))
          throw new Error(
            "The operation did not complete successfully. See its final event for details.",
          );
        return;
      }
    }
    if (completion)
      throw new Error(
        "The connection ended before completion was confirmed. Reattach to the existing operation to check its outcome.",
      );
  } catch (error) {
    observeCaughtError(error, "cli/lib/event-output");
    fail(error);
  }
}
