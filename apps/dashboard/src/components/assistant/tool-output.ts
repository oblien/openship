/** BytesMap's envelope parser, shared by the display and its tests. No fetching or execution. */
export const openshipToolName = (name: string) =>
  name.replace(/^(mcp__openship__|mcp__openship_|openship\.|functions\.)/, "");

export const outputRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
export function parseToolOutput(output: unknown): { value: unknown; isError: boolean } {
  let value = output,
    isError = false;
  for (let depth = 0; depth < 8; depth++) {
    if (typeof value === "string") {
      try {
        const parsed: unknown = JSON.parse(value);
        if (parsed === value) break;
        value = parsed;
        continue;
      } catch {
        break;
      }
    }
    const record = outputRecord(value);
    if (record?.isError === true || record?.success === false) isError = true;
    if (record?.jsonrpc === "2.0") {
      if ("error" in record) {
        isError = true;
        value = record.error;
      } else if ("result" in record) value = record.result;
      else break;
      continue;
    }
    if (record?.structuredContent != null) {
      value = record.structuredContent;
      continue;
    }
    const blocks = Array.isArray(value) ? value : record?.content;
    if (
      Array.isArray(blocks) &&
      blocks.length &&
      blocks.every((b) => outputRecord(b)?.type === "text")
    ) {
      value = blocks.map((b) => outputRecord(b)?.text ?? "").join("\n");
      continue;
    }
    if (
      record &&
      "data" in record &&
      Object.keys(record).every((k) => ["data", "success", "message"].includes(k))
    ) {
      value = record.data;
      continue;
    }
    break;
  }
  return { value, isError };
}
export const outputLabel = (value: string) =>
  value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .replace(/^./, (c) => c.toUpperCase());
