function varint(value: number): number[] {
  const bytes: number[] = [];
  let remaining = value;
  while (remaining >= 0x80) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(remaining);
  return bytes;
}

function lengthField(field: number, payload: number[]): number[] {
  return [...varint(field * 8 + 2), ...varint(payload.length), ...payload];
}

function varintField(field: number, value: number): number[] {
  return [...varint(field * 8), ...varint(value)];
}

function utf8(value: string): number[] {
  return [...Buffer.from(value, "utf-8")];
}

export function statusResponse(options: {
  vertexes?: Array<{
    digest: string;
    name?: string;
    cached?: boolean;
    completed?: boolean;
    error?: string;
  }>;
  logs?: Array<{ vertex: string; stream?: number; msg: string }>;
}): string {
  const bytes: number[] = [];

  for (const vertex of options.vertexes ?? []) {
    const body = [
      ...lengthField(1, utf8(vertex.digest)),
      ...(vertex.name ? lengthField(3, utf8(vertex.name)) : []),
      ...(vertex.cached ? varintField(4, 1) : []),
      ...(vertex.completed ? lengthField(6, varintField(1, 1_700_000_000)) : []),
      ...(vertex.error ? lengthField(7, utf8(vertex.error)) : []),
    ];
    bytes.push(...lengthField(1, body));
  }

  for (const log of options.logs ?? []) {
    const body = [
      ...lengthField(1, utf8(log.vertex)),
      ...lengthField(2, varintField(1, 1_700_000_000)),
      ...varintField(3, log.stream ?? 1),
      ...lengthField(4, utf8(log.msg)),
    ];
    bytes.push(...lengthField(3, body));
  }

  return Buffer.from(bytes).toString("base64");
}
