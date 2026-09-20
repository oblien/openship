/**
 * Shared by the source-level guards that scan this repo's own text.
 *
 * Named `.fixtures.ts` because that suffix is what `host-command-ownership.test.ts`'s
 * `sources()` skips — a scanner that scanned its own scanner would be reporting on itself.
 */

/**
 * Blank block and line comments in place, so a match is code rather than an explanation
 * of code — and so the line a match sits on is still its line in the file.
 *
 * A `replace(/\/\*[\s\S]*?\*\//g, "")` cannot do this, and not only because it collapses
 * lines: `*` is a shell glob, so `` `${sitesDir}/*.conf` `` opens a comment the source
 * never opened, and it stays open until the next close marker — some later JSDoc's, dozens
 * of lines down. Every command in between became invisible to the guard. A regex literal
 * does it too: `/^[\w./*?-]+$/` hid 61 lines of `runtime/cloud.ts` from its own ratchet,
 * which is why this lives in one place now instead of being re-derived per guard. So the
 * scan has to know a string from code. Over-stripping is the one failure mode that would
 * make a guard pass for the wrong reason, so `:` still shields `https://`, and anything
 * this misreads is copied through rather than dropped.
 */
export function blankComments(src: string): string {
  let out = "";
  let token = ""; // previous significant token: an identifier, or one punctuation char
  let word = "";
  const flush = () => {
    if (word) {
      token = word;
      word = "";
    }
  };
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) out += src[k] === "\n" ? "\n" : " ";
  };
  const keep = (from: number, to: number) => {
    out += src.slice(from, to);
  };
  // A `/` opens a regex only where a value cannot already have ended. `>` is in here for
  // `=> /re/`, which is the commonest position of all — `.filter((k) => /…/.test(k))` —
  // and it is safe because a division can never follow `>`. `<` is absent on purpose:
  // `</div>` is far more common in .tsx than a regex compared with `<`.
  const OPENS_VALUE = "(,=:[!&|?{};+-*%~^>";
  const KEYWORDS = new Set([
    "return",
    "typeof",
    "case",
    "in",
    "of",
    "do",
    "else",
    "yield",
    "await",
    "new",
    "delete",
    "void",
    "instanceof",
  ]);
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    const d = src[i + 1];
    if (c === "/" && d === "/" && src[i - 1] !== ":") {
      let j = i;
      while (j < src.length && src[j] !== "\n") j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === "/" && d === "*") {
      const close = src.indexOf("*/", i + 2);
      const j = close === -1 ? src.length : close + 2;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      keep(i, Math.min(j + 1, src.length));
      i = j + 1;
      flush();
      token = c;
      continue;
    }
    if (c === "`") {
      // Kept whole, `${…}` included: an interpolation holds code, but code inside a
      // template cannot open a comment that outlives the literal.
      let j = i + 1;
      let depth = 0;
      while (j < src.length) {
        const ch = src[j];
        if (ch === "\\") {
          j += 2;
          continue;
        }
        if (depth === 0) {
          if (ch === "`") break;
          if (ch === "$" && src[j + 1] === "{") {
            depth = 1;
            j += 2;
            continue;
          }
        } else if (ch === "{") depth++;
        else if (ch === "}") depth--;
        j++;
      }
      keep(i, Math.min(j + 1, src.length));
      i = j + 1;
      flush();
      token = "`";
      continue;
    }
    if (c === "/") {
      flush();
      if (token === "" || OPENS_VALUE.includes(token) || KEYWORDS.has(token)) {
        let j = i + 1;
        let charClass = false;
        while (j < src.length && src[j] !== "\n") {
          const ch = src[j];
          if (ch === "\\") {
            j += 2;
            continue;
          }
          if (ch === "[") charClass = true;
          else if (ch === "]") charClass = false;
          else if (ch === "/" && !charClass) break;
          j++;
        }
        keep(i, Math.min(j + 1, src.length));
        i = j + 1;
        token = "/";
        continue;
      }
    }
    out += c;
    if (/[\w$]/.test(c)) word += c;
    else {
      flush();
      if (!/\s/.test(c)) token = c;
    }
    i++;
  }
  return out;
}
