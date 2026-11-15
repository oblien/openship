/** Literal forms emitted by shells and JSON loggers. No credential-name heuristics. */
export function secretValueLiterals(values: readonly string[]): string[] {
  return [
    ...new Set(
      values.filter(Boolean).flatMap((value) => [
        value,
        JSON.stringify(value).slice(1, -1),
        value.replace(/'/g, `'\\''`),
        // Multi-line credentials are often printed one line at a time with a build
        // progress prefix. Ignore punctuation-only JSON lines, not credential lines.
        ...value.split(/\r?\n/).filter((line) => /[\p{L}\p{N}]/u.test(line)),
      ]),
    ),
  ];
}

type Node = { next: Map<string, number>; fail: number; depth: number; match: number };
type Span = { start: number; end: number };
const MASK = "***";

/** Compiled literal matcher shared by complete messages and arbitrary byte chunks.
 * Failure links bound scanning to the input size, even for repeated prefixes or
 * large JSON keys. Replacement text is never matched against another secret. */
export class SecretValues {
  private nodes: Node[] = [{ next: new Map(), fail: 0, depth: 0, match: 0 }];
  readonly empty: boolean;
  readonly maxLength: number;

  constructor(values: readonly string[]) {
    const literals = secretValueLiterals(values);
    this.empty = literals.length === 0;
    this.maxLength = literals.reduce((max, value) => Math.max(max, value.length), 0);
    for (const literal of literals) {
      let node = 0;
      // UTF-16 units deliberately match String.slice boundaries.
      for (let i = 0; i < literal.length; i++) {
        const char = literal[i]!;
        let next = this.nodes[node]!.next.get(char);
        if (next === undefined) {
          next = this.nodes.length;
          this.nodes[node]!.next.set(char, next);
          this.nodes.push({
            next: new Map(),
            fail: 0,
            depth: this.nodes[node]!.depth + 1,
            match: 0,
          });
        }
        node = next;
      }
      this.nodes[node]!.match = literal.length;
    }
    const queue = [...this.nodes[0]!.next.values()];
    for (let i = 0; i < queue.length; i++) {
      const node = this.nodes[queue[i]!]!;
      for (const [char, child] of node.next) {
        let fail = node.fail;
        while (fail && !this.nodes[fail]!.next.has(char)) fail = this.nodes[fail]!.fail;
        const target = this.nodes[fail]!.next.get(char) ?? 0;
        this.nodes[child]!.fail = target;
        this.nodes[child]!.match = Math.max(this.nodes[child]!.match, this.nodes[target]!.match);
        queue.push(child);
      }
    }
  }

  private scan(value: string, state = 0): { spans: Span[]; pending: number; state: number } {
    const spans: Span[] = [];
    for (let i = 0; i < value.length; i++) {
      const char = value[i]!;
      while (state && !this.nodes[state]!.next.has(char)) state = this.nodes[state]!.fail;
      state = this.nodes[state]!.next.get(char) ?? 0;
      const length = this.nodes[state]!.match;
      if (length) {
        let start = i + 1 - length;
        while (spans.length && spans[spans.length - 1]!.end > start)
          start = Math.min(start, spans.pop()!.start);
        spans.push({ start, end: i + 1 });
      }
    }
    // A leaf cannot become a longer secret; a suffix on its failure chain can.
    while (state && !this.nodes[state]!.next.size) state = this.nodes[state]!.fail;
    return { spans, pending: value.length - this.nodes[state]!.depth, state };
  }

  ranges(value: string): readonly Span[] {
    return this.scan(value).spans;
  }

  private render(value: string, spans: Span[], end = value.length): string {
    const parts: string[] = [];
    let cursor = 0;
    for (const span of spans) {
      if (span.start >= end) break;
      parts.push(value.slice(cursor, span.start), MASK);
      cursor = span.end;
    }
    parts.push(value.slice(cursor, end));
    return parts.join("");
  }

  redact(value: string): string {
    return this.empty ? value : this.render(value, this.scan(value).spans);
  }

  stream(): { write: (chunk: string) => string; end: () => string } {
    let pending = "";
    let covered: Span[] = [];
    let masked = false;
    let state = 0;
    return {
      write: (chunk) => {
        if (this.empty) return chunk;
        const value = pending + chunk;
        // Carry the automaton across chunks. Rescanning a long pending secret
        // on every byte would make fragmented output quadratic in its length.
        const result = this.scan(chunk, state);
        state = result.state;
        result.spans = result.spans.map(span => ({ start: span.start + pending.length, end: span.end + pending.length }));
        result.pending += pending.length;
        // A complete match can overlap an unfinished longer value. Remember
        // coverage of the retained suffix so a later mismatch cannot reveal it.
        // Retain only the suffix, never an arbitrarily long overlapping match.
        const spans = [...covered, ...result.spans].sort((a, b) => a.start - b.start);
        const parts: string[] = [];
        let cursor = 0;
        for (const span of spans) {
          if (span.start >= result.pending) break;
          if (span.end <= cursor) continue;
          if (span.start > cursor) {
            parts.push(value.slice(cursor, span.start));
            masked = false;
          }
          if (!masked) parts.push(MASK);
          masked = true;
          cursor = Math.min(span.end, result.pending);
        }
        if (cursor < result.pending) {
          parts.push(value.slice(cursor, result.pending));
          masked = false;
        }
        covered = spans
          .filter((span) => span.end > result.pending)
          .map((span) => ({
            start: Math.max(0, span.start - result.pending),
            end: span.end - result.pending,
          }));
        // Coalesce retained ranges; repeated prefixes must not grow state across
        // chunks. They are already ordered by start.
        covered = covered.reduce<Span[]>((out, span) => {
          const last = out.at(-1);
          if (last && last.end >= span.start) last.end = Math.max(last.end, span.end);
          else out.push(span);
          return out;
        }, []);
        pending = value.slice(result.pending);
        return parts.join("");
      },
      // A truncated credential prefix must not escape when a process dies.
      end: () => {
        const result = pending && !masked ? MASK : "";
        pending = "";
        covered = [];
        masked = false;
        state = 0;
        return result;
      },
    };
  }
}
