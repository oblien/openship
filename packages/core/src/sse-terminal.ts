/**
 * Read one terminal `complete` or `error` event from an SSE response.
 *
 * Frames may be split at arbitrary byte boundaries and may use LF or CRLF.
 * Heartbeats/comments and non-terminal progress events are ignored. Keeping
 * this parser in core prevents server-to-server and browser transfer clients
 * from implementing subtly different framing rules.
 */
const MAX_PENDING_SSE_CHARS = 1_000_000;

export async function readSseTerminalEvent(
  body: ReadableStream<Uint8Array>,
): Promise<{ event: "complete" | "error"; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });

      let match = /\r?\n\r?\n/.exec(buffer);
      while (match?.index !== undefined) {
        const frame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const lines = frame.split(/\r?\n/);
        const event = lines
          .find((line) => line.startsWith("event:"))
          ?.slice(6)
          .trim();
        const data = lines
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if ((event === "complete" || event === "error") && data) {
          return { event, data };
        }
        match = /\r?\n\r?\n/.exec(buffer);
      }

      if (buffer.length > MAX_PENDING_SSE_CHARS) {
        throw new Error("The event stream sent an oversized frame.");
      }

      if (done) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  throw new Error("The event stream ended without a terminal result.");
}
