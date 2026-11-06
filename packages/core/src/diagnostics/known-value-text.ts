/** Keep known values marked while patterns inspect the original syntax. Pattern
 * replacements carry those marks forward for surviving input only; generated
 * markers are never scanned as secrets. Each positive mark identifies one
 * original match, preserving boundaries between adjacent known values. */
export class KnownValueText {
  private value: string;
  private marks: Uint32Array;

  constructor(value: string, secrets: readonly string[], inputLimit: number) {
    const literals = [...new Set(secrets.filter(Boolean).flatMap((secret) => [
      secret, JSON.stringify(secret).slice(1, -1),
    ]))].sort((a, b) => b.length - a.length);
    this.value = value.slice(0, inputLimit);
    this.marks = new Uint32Array(this.value.length);
    if (!literals.length) return;
    const matcher = new RegExp(
      literals.map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
      "g",
    );
    // Look past the input boundary so clipping cannot expose part of a value.
    const input = value.slice(0, inputLimit + literals[0]!.length);
    let id = 0;
    for (const match of input.matchAll(matcher)) {
      if (match.index >= inputLimit) break;
      this.marks.fill(++id, match.index, Math.min(match.index + match[0].length, inputLimit));
    }
  }

  replace(pattern: RegExp, replacement: string | ((...matches: string[]) => string)): this {
    const parts: { value: string; source?: number }[] = [];
    let cursor = 0;
    let length = 0;
    for (const match of this.value.matchAll(pattern)) {
      const start = match.index;
      const end = start + match[0].length;
      const prefix = this.value.slice(cursor, start);
      // Callback replacements can retain input (URL host/path, for example).
      // Hide the whole match when that input includes any known private value.
      let next = typeof replacement === "string" ? replacement : replacement(...match);
      const unchanged = typeof replacement === "function" && next === match[0];
      if (
        typeof replacement === "function" && !unchanged &&
        this.marks.subarray(start, end).some((id) => id !== 0)
      ) next = "[REDACTED]";
      parts.push({ value: prefix, source: cursor }, { value: next, ...(unchanged && { source: start }) });
      length += prefix.length + next.length;
      cursor = end;
    }
    if (!parts.length) return this;
    const tail = this.value.slice(cursor);
    parts.push({ value: tail, source: cursor });
    const marks = new Uint32Array(length + tail.length);
    let offset = 0;
    for (const part of parts) {
      if (part.source !== undefined)
        marks.set(this.marks.subarray(part.source, part.source + part.value.length), offset);
      offset += part.value.length;
    }
    this.value = parts.map((part) => part.value).join("");
    this.marks = marks;
    return this;
  }

  finish(limit: number): string {
    let text = "";
    for (let cursor = 0; cursor < this.value.length && text.length < limit;) {
      const id = this.marks[cursor];
      if (!id) {
        text += this.value[cursor++];
        continue;
      }
      text += "[REDACTED]";
      do { cursor++; } while (this.marks[cursor] === id);
    }
    return text.slice(0, limit);
  }
}

