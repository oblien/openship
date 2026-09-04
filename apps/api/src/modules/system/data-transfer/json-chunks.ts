/** Bounded JSON encoding used by direct transfer.
 *
 * `JSON.stringify(wholeDump)` briefly duplicates the entire instance in memory.
 * This encoder preserves JSON.stringify semantics for transfer payloads while
 * yielding fixed-size UTF-8 chunks. Large string cells (notably build logs) are
 * escaped in slices, so one oversized row cannot recreate the same spike.
 */

const STRING_SLICE_CHARS = 64 * 1024;

function omitted(value: unknown): boolean {
  return value === undefined || typeof value === "function" || typeof value === "symbol";
}

function* stringFragments(value: string): Generator<string> {
  yield '"';
  for (let start = 0; start < value.length; ) {
    let end = Math.min(value.length, start + STRING_SLICE_CHARS);
    // Never split a UTF-16 surrogate pair between independently escaped slices.
    if (end < value.length) {
      const last = value.charCodeAt(end - 1);
      if (last >= 0xd800 && last <= 0xdbff) end -= 1;
    }
    const encoded = JSON.stringify(value.slice(start, end));
    yield encoded.slice(1, -1);
    start = end;
  }
  yield '"';
}

function applyToJSON(value: unknown, key: string): unknown {
  if (value && typeof value === "object") {
    const toJSON = (value as { toJSON?: (key: string) => unknown }).toJSON;
    if (typeof toJSON === "function") return toJSON.call(value, key);
  }
  return value;
}

/** Serialize a value after its own toJSON hook has already run. */
function* fragments(value: unknown, seen: WeakSet<object>): Generator<string> {
  if (typeof value === "string") {
    yield* stringFragments(value);
    return;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    yield JSON.stringify(value);
    return;
  }
  if (typeof value === "bigint") {
    // Match JSON.stringify rather than silently changing database values.
    throw new TypeError("Do not know how to serialize a BigInt");
  }
  if (omitted(value)) {
    yield "null";
    return;
  }

  const object = value as object;
  if (seen.has(object)) throw new TypeError("Converting circular structure to JSON");

  seen.add(object);
  try {
    if (Array.isArray(value)) {
      yield "[";
      for (let i = 0; i < value.length; i += 1) {
        if (i > 0) yield ",";
        const item = applyToJSON(value[i], String(i));
        yield* fragments(omitted(item) ? null : item, seen);
      }
      yield "]";
      return;
    }

    yield "{";
    let first = true;
    for (const key of Object.keys(value as Record<string, unknown>)) {
      const item = applyToJSON((value as Record<string, unknown>)[key], key);
      if (omitted(item)) continue;
      if (!first) yield ",";
      first = false;
      yield JSON.stringify(key);
      yield ":";
      yield* fragments(item, seen);
    }
    yield "}";
  } finally {
    seen.delete(object);
  }
}

export function* jsonByteChunks(value: unknown, maxBytes: number): Generator<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError("maxBytes must be a positive safe integer");
  }
  let parts: Buffer[] = [];
  let buffered = 0;
  const root = applyToJSON(value, "");
  if (omitted(root)) return;

  for (const fragment of fragments(root, new WeakSet())) {
    let bytes = Buffer.from(fragment, "utf8");
    while (bytes.length > 0) {
      const available = maxBytes - buffered;
      const take = Math.min(available, bytes.length);
      parts.push(bytes.subarray(0, take));
      buffered += take;
      bytes = bytes.subarray(take);
      if (buffered === maxBytes) {
        yield Buffer.concat(parts, buffered);
        parts = [];
        buffered = 0;
      }
    }
  }

  if (buffered > 0) yield Buffer.concat(parts, buffered);
}
