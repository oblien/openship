/** The Host/Path/PathPrefix subset that an OpenResty route can preserve exactly. */
export interface TraefikRuleMatch {
  hosts?: string[];
  path?: string;
  exact?: boolean;
}

type Token = "(" | ")" | "&&" | "||" | TraefikRuleMatch[];

function intersect(a: TraefikRuleMatch, b: TraefikRuleMatch): TraefikRuleMatch | null {
  const hosts =
    a.hosts && b.hosts ? a.hosts.filter((host) => b.hosts!.includes(host)) : (a.hosts ?? b.hosts);
  if (hosts?.length === 0) return null;
  let path = a.path ? a : b;
  if (a.path && b.path) {
    if (a.exact) {
      if (b.exact ? a.path !== b.path : !a.path.startsWith(b.path)) return null;
      path = a;
    } else if (b.exact) {
      if (!b.path.startsWith(a.path)) return null;
      path = b;
    } else if (a.path.startsWith(b.path)) path = a;
    else if (b.path.startsWith(a.path)) path = b;
    else return null;
  }
  return { hosts, path: path.path, ...(path.exact ? { exact: true } : {}) };
}

/** Unsupported/invalid expressions return null; never broaden them to just Host(). */
export function parseTraefikRule(rule: string): TraefikRuleMatch[] | null {
  if (rule.length > 10_000) return null;
  const tokens: Token[] = [];
  let remaining = rule.trim();
  while (remaining) {
    const operator = remaining.match(/^(\(|\)|&&|\|\|)/);
    if (operator) {
      tokens.push(operator[0] as Token);
      remaining = remaining.slice(operator[0].length).trimStart();
      continue;
    }
    const atom = remaining.match(/^(Host|PathPrefix|Path)\s*\(([^()]*)\)/i);
    if (!atom) return null;
    const args: string[] = [];
    let raw = atom[2].trim();
    while (raw) {
      const argument = raw.match(/^(?:`([^`]*)`|"([^"\\]*)"|'([^'\\]*)')/);
      if (!argument) return null;
      args.push(argument[1] ?? argument[2] ?? argument[3]);
      raw = raw.slice(argument[0].length).trimStart();
      if (!raw) break;
      if (!raw.startsWith(",")) return null;
      raw = raw.slice(1).trimStart();
      if (!raw) return null;
    }
    if (!args.length || args.some((value) => !value || /[\r\n\0]/.test(value))) return null;
    if (atom[1].toLowerCase() === "host")
      tokens.push([{ hosts: [...new Set(args.map((host) => host.trim().toLowerCase()))] }]);
    else {
      if (args.some((path) => !path.startsWith("/"))) return null;
      tokens.push(
        args.map((path) => ({
          path,
          ...(atom[1].toLowerCase() === "path" ? { exact: true } : {}),
        })),
      );
    }
    remaining = remaining.slice(atom[0].length).trimStart();
  }

  let cursor = 0;
  const primary = (depth: number): TraefikRuleMatch[] | null => {
    if (depth > 32) return null;
    const token = tokens[cursor++];
    if (Array.isArray(token)) return token;
    if (token !== "(") return null;
    const result = or(depth + 1);
    return tokens[cursor++] === ")" ? result : null;
  };
  const and = (depth: number): TraefikRuleMatch[] | null => {
    let result = primary(depth);
    while (result && tokens[cursor] === "&&") {
      cursor++;
      const right = primary(depth);
      if (!right || result.length * right.length > 256) return null;
      result = result.flatMap((a) => right.flatMap((b) => intersect(a, b) ?? []));
    }
    return result;
  };
  const or = (depth: number): TraefikRuleMatch[] | null => {
    let result = and(depth);
    while (result && tokens[cursor] === "||") {
      cursor++;
      const right = and(depth);
      if (!right || result.length + right.length > 256) return null;
      result = [...result, ...right];
    }
    return result;
  };
  const result = or(0);
  return cursor === tokens.length ? result : null;
}
