/** Decode DNS presentation syntax, preserving a raw value when it is not a
 * complete sequence of quoted character strings. Separate records must never
 * be concatenated; only the chunks within one TXT record are joined. */
export function dnsTxtValue(value: string): string {
  if (!value.startsWith('"')) return value;
  const bytes: Buffer[] = [];
  let index = 0;
  while (index < value.length) {
    if (value[index++] !== '"') return value;
    let closed = false;
    while (index < value.length) {
      const char = value[index++];
      if (char === '"') { closed = true; break; }
      if (char === "\\") {
        if (index >= value.length) return value;
        const decimal = value.slice(index, index + 3);
        if (/^\d{3}$/.test(decimal)) {
          const byte = Number(decimal);
          if (byte > 255) return value;
          bytes.push(Buffer.from([byte])); index += 3;
        } else bytes.push(Buffer.from(value[index++]!));
      } else {
        const point = value.codePointAt(index - 1)!;
        const text = String.fromCodePoint(point);
        bytes.push(Buffer.from(text));
        if (text.length === 2) index++;
      }
    }
    if (!closed) return value;
    while (/\s/.test(value[index] ?? "") && index < value.length) index++;
    if (index < value.length && value[index] !== '"') return value;
  }
  return Buffer.concat(bytes).toString("utf8");
}

/** Cloudflare expects TXT content in quoted DNS presentation syntax. Its JSON
 * envelope adds another escaping layer; the quotes here are DNS delimiters,
 * not literal bytes of the published ownership token. */
export function quotedDnsTxt(value: string): string {
  const chunks: string[] = [];
  let chunk = "";
  let bytes = 0;
  for (const char of dnsTxtValue(value)) {
    const size = Buffer.byteLength(char);
    if (bytes + size > 255) { chunks.push(`"${chunk}"`); chunk = ""; bytes = 0; }
    const code = char.codePointAt(0)!;
    chunk += char === '"' || char === "\\" ? `\\${char}`
      : code < 32 || code === 127 ? `\\${code.toString().padStart(3, "0")}` : char;
    bytes += size;
  }
  chunks.push(`"${chunk}"`);
  return chunks.join(" ");
}
