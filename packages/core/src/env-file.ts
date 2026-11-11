export interface EnvFileEntry {
  key: string;
  /** Literal value, suitable for an environment editor. */
  value: string;
  /** Compose expression, with escaped dollars protected as $$. */
  interpolation?: string;
}

export class EnvFileSyntaxError extends Error {
  constructor(readonly line: number) {
    super(`Invalid .env syntax on line ${line}`);
    this.name = "EnvFileSyntaxError";
  }
}

const DOUBLE_QUOTE_ESCAPES: Readonly<Record<string, string>> = {
  a: "\x07",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  '"': '"',
  "\\": "\\",
  $: "$",
};

function closingQuote(content: string, start: number, quote: string): number {
  let escaped = false;
  for (let i = start; i < content.length; i++) {
    const char = content[i];
    if (char === quote && !escaped) return i;
    escaped = char === "\\" && !escaped;
  }
  return -1;
}

/** Read Compose-compatible .env syntax without resolving variable references.
 * Keeping literal values separate from expressions lets editor imports and
 * Compose interpolation share quoting rules without expanding saved secrets.
 * Strict mode validates whole-file edits, rejecting invalid lines and duplicate keys. */
export function parseEnvFile(content: string, options: { strict?: boolean } = {}): EnvFileEntry[] {
  const entries: EnvFileEntry[] = [];
  const keys = new Set<string>();
  const fail = (offset: number) => {
    const line = content.slice(0, offset).split("\n").length;
    throw new EnvFileSyntaxError(line);
  };
  if (options.strict && content.includes("\0")) fail(content.indexOf("\0"));
  let cursor = content.startsWith("\uFEFF") ? 1 : 0;
  while (cursor < content.length) {
    const newline = content.indexOf("\n", cursor);
    const lineEnd = newline < 0 ? content.length : newline;
    const line = content.slice(cursor, lineEnd);
    const assignment = line.match(
      /^[^\S\r\n]*(?:export[^\S\r\n]+)?([A-Za-z_][A-Za-z0-9_]*)[^\S\r\n]*=[^\S\r\n]*/,
    );
    const valueStart = cursor + (assignment?.[0].length ?? 0);
    cursor = lineEnd + 1;
    if (!assignment) {
      if (options.strict && line.trim() && !line.trimStart().startsWith("#")) fail(valueStart);
      continue;
    }

    const key = assignment[1]!;
    if (options.strict && keys.has(key)) fail(valueStart);
    keys.add(key);
    const quote = content[valueStart];
    if (quote === '"' || quote === "'") {
      const end = closingQuote(content, valueStart + 1, quote);
      if (options.strict) {
        if (end < 0) fail(valueStart);
        const tailEnd = content.indexOf("\n", end + 1);
        const tail = content.slice(end + 1, tailEnd < 0 ? content.length : tailEnd).trim();
        if (tail && !tail.startsWith("#")) fail(end + 1);
      }
      const quoted = content.slice(valueStart + 1, end < 0 ? lineEnd : end);
      if (end >= 0) {
        const nextLine = content.indexOf("\n", end + 1);
        cursor = nextLine < 0 ? content.length : nextLine + 1;
      }
      if (quote === "'") {
        entries.push({ key, value: quoted.replace(/\\'/g, "'") });
      } else {
        const decode = (protectDollars: boolean) =>
          quoted.replace(/\\([abfnrtv"\\$])/g, (_match, char: string) =>
            char === "$" && protectDollars ? "$$" : DOUBLE_QUOTE_ESCAPES[char]!,
          );
        entries.push({ key, value: decode(false), interpolation: decode(true) });
      }
    } else {
      const value = content
        .slice(valueStart, lineEnd)
        .replace(/\s+#.*$/, "")
        .trimEnd();
      entries.push({ key, value, interpolation: value });
    }
  }
  return entries;
}

const ENCODE_ESCAPES: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(DOUBLE_QUOTE_ESCAPES).map(([escape, value]) => [value, `\\${escape}`]),
);

/** Export literal environment values. Simple assignments stay readable; quoted
 * values follow Compose .env escaping so $ in a secret is never expanded. */
export function serializeEnvFile(rows: ReadonlyArray<{ key: string; value: string }>): string {
  const keys = new Set<string>();
  const lines = rows.map(({ key: rawKey, value }) => {
    const key = rawKey.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || keys.has(key)) {
      throw new Error("Environment variable names must be valid and unique");
    }
    keys.add(key);
    if (value.includes("\0")) throw new Error("Environment values cannot contain null bytes");
    const trailingBackslashes = value.match(/\\+$/)?.[0].length ?? 0;
    let encoded: string;
    if (value === value.trim() && !/[\r\n#$]/.test(value) && !/^["'`]/.test(value)) {
      encoded = value;
    } else if (!value.includes("'") && !value.includes("\r") && trailingBackslashes % 2 === 0) {
      encoded = `'${value}'`;
    } else {
      encoded = `"${value.replace(/[\x07\b\f\n\r\t\v"\\$]/g, (char) => ENCODE_ESCAPES[char]!)}"`;
    }
    return `${key}=${encoded}`;
  });
  return lines.length ? `${lines.join("\n")}\n` : "";
}
