import { ValidationError } from "@repo/core";

type Token = { accepts: (char: string) => boolean; min: number; max: number } | { prefix: true };
/** GitHub stars, globstars, character ranges, ?, + and escaping. Dynamic programming
 * avoids running workflow-supplied backtracking regexes on untrusted PR filenames. */
export function matchesActionPattern(pattern: string, value: string): boolean {
  if (pattern.length > 512 || value.length > 2048)
    throw new ValidationError("Workflow filter exceeds its length limit");
  const tokens: Token[] = [];
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (pattern.slice(i, i + 3) === "**/") {
      tokens.push({ prefix: true });
      i += 2;
    } else if (char === "*") {
      const all = pattern[i + 1] === "*";
      tokens.push({ accepts: (value) => all || value !== "/", min: 0, max: Infinity });
      if (all) i++;
    } else if ((char === "?" || char === "+") && tokens.length) {
      const previous = tokens.at(-1)!;
      if ("prefix" in previous || previous.min !== 1 || previous.max !== 1)
        throw new ValidationError("Invalid quantified workflow filter");
      previous.min = char === "?" ? 0 : 1;
      previous.max = char === "+" ? Infinity : 1;
    } else if (char === "[") {
      const end = pattern.indexOf("]", i + 1);
      const range = pattern.slice(i + 1, end);
      if (end < 0 || !/^[A-Za-z0-9-]+$/.test(range))
        throw new ValidationError("Invalid workflow character range");
      const allowed = new Set<string>();
      for (let j = 0; j < range.length; j++) {
        if (range[j + 1] === "-") {
          if (!range[j + 2] || range[j]! > range[j + 2]!)
            throw new ValidationError("Invalid workflow character range");
          for (let code = range.charCodeAt(j); code <= range.charCodeAt(j + 2); code++)
            allowed.add(String.fromCharCode(code));
          j += 2;
        } else allowed.add(range[j]!);
      }
      tokens.push({ accepts: (value) => allowed.has(value), min: 1, max: 1 });
      i = end;
    } else {
      const literal = char === "\\" ? pattern[++i] : char;
      if (literal === undefined)
        throw new ValidationError("A workflow filter ends with an incomplete escape");
      tokens.push({ accepts: (value) => value === literal, min: 1, max: 1 });
    }
  }
  let reachable = new Uint8Array(value.length + 1);
  reachable[0] = 1;
  for (const token of tokens) {
    const next = new Uint8Array(value.length + 1);
    if ("prefix" in token) {
      let earliest = -1;
      for (let j = 0; j <= value.length; j++) {
        if (reachable[j] && earliest < 0) earliest = j;
        if (reachable[j] || (earliest >= 0 && j >= earliest + 2 && value[j - 1] === "/"))
          next[j] = 1;
      }
    } else {
      for (let j = 0; j <= value.length; j++) {
        if (token.min === 0 && reachable[j]) next[j] = 1;
        if (
          j &&
          token.accepts(value[j - 1]!) &&
          (reachable[j - 1] || (token.max === Infinity && next[j - 1]))
        )
          next[j] = 1;
      }
    }
    reachable = next;
  }
  return reachable[value.length] === 1;
}

export function matchesActionFilters(
  patterns: unknown,
  values: string[],
  ignored = false,
): boolean {
  if (patterns === undefined) return true;
  if (
    !Array.isArray(patterns) ||
    patterns.length > 100 ||
    patterns.some((pattern) => typeof pattern !== "string")
  )
    throw new ValidationError("Workflow filters require up to 100 patterns");
  const match = (value: string) => {
    let matched = false;
    for (const raw of patterns as string[]) {
      const negative = raw.startsWith("!");
      if (matchesActionPattern(negative ? raw.slice(1) : raw, value)) matched = !negative;
    }
    return matched;
  };
  return ignored ? values.some((value) => !match(value)) : values.some(match);
}
