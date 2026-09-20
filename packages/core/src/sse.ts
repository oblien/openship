export interface SSEEvent {
  event: string;
  data: string;
  id?: string;
  retry?: number;
}

/** Decode SSE framing independently of chunk boundaries and UTF-8 byte boundaries. */
export async function* parseSSE(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SSEEvent, void, unknown> {
  const reader = stream.getReader();
  let ended = false;
  try {
    yield* parseSSEChunks({
      async *[Symbol.asyncIterator]() {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) { ended = true; return; }
          yield chunk.value;
        }
      },
    });
  } finally {
    if (!ended) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** The same decoder for provider and native-worker byte iterators. */
export async function* parseSSEChunks(
  stream: AsyncIterable<Uint8Array>,
): AsyncGenerator<SSEEvent, void, unknown> {
  const reader = stream[Symbol.asyncIterator]();
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "message";
  let data: string[] = [];
  let id: string | undefined;
  let retry: number | undefined;
  let ended = false;

  const flush = (): SSEEvent | null => {
    if (!data.length) {
      event = "message";
      return null;
    }
    const result: SSEEvent = { event, data: data.join("\n") };
    if (id !== undefined) result.id = id;
    if (retry !== undefined) result.retry = retry;
    event = "message";
    data = [];
    return result;
  };

  try {
    for (;;) {
      const chunk = await reader.next();
      if (chunk.done) {
        ended = true;
        if (!buffer.endsWith("\r")) break;
        buffer += "\n";
      } else {
        buffer += decoder.decode(chunk.value, { stream: true });
      }
      for (;;) {
        const index = buffer.search(/[\r\n]/);
        if (index < 0) break;
        // A CR at a chunk boundary may be the start of CRLF.
        if (buffer[index] === "\r" && index === buffer.length - 1) break;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + (buffer.slice(index, index + 2) === "\r\n" ? 2 : 1));
        if (!line) {
          const result = flush();
          if (result) yield result;
          continue;
        }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "event") event = value || "message";
        else if (field === "data") data.push(value);
        else if (field === "id" && !value.includes("\0")) id = value;
        else if (field === "retry" && /^\d+$/.test(value)) retry = Number(value);
      }
      if (ended) break;
    }
    // Preserve the API/CLI's historical EOF behavior: complete lines dispatch,
    // while an unterminated partial line cannot be trusted as a complete event.
    const result = flush();
    if (result) yield result;
  } finally {
    if (!ended) await reader.return?.();
  }
}
