/** Bound the decoded response size, even when Content-Length is missing or compressed. */
export async function readBoundedResponseText(
  response: Response,
  maxBytes: number,
  label: string,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error(label + " is empty.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (Number(response.headers.get("content-length")) > maxBytes)
      throw new Error(label + " is too large.");
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error(label + " is too large.");
      chunks.push(value);
    }
    return Buffer.concat(chunks, size).toString("utf8");
  } finally {
    await reader.cancel().catch(() => {
      // diagnostics-ignore: cleanup must not replace the primary read error.
    });
  }
}
