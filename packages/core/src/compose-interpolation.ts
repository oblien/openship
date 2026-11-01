/** Browser-safe Compose interpolation shared by source parsing, deployment and previews. */
import { parseEnvFile } from "./env-file";

/** A mandatory compose variable with no value yet. */
export interface ComposeMissingVariable {
  variable: string;
  /** The author's own word after `:?`, VERBATIM — never interpolated, so a
   *  nested `${SECRET}` in the message can't ride out through a scan response. */
  message?: string;
}

export interface ComposeEnvironmentMeta {
  source: "env-file" | "default" | "missing" | "interpolated";
  variable?: string;
  defaultValue?: string;
  resolvedValue: string;
  expression?: string;
  /** The file declares this one mandatory (`:?` / `?`). Only set when it also
   *  came back unresolved, i.e. alongside `source: "missing"`. */
  required?: boolean;
  /** Unresolved variable names inside an embedded expression. Names only. */
  unresolvedVariables?: string[];
}

/**
 * Where {@link resolveInterpolationExpression} reports unsatisfied mandatory
 * variables. Keyed by the interpolation env object of the parse that's running,
 * so a sink is scoped to one `parseComposeFile` call and there is no global state
 * to reset — a resolver reached with any other env record (`.env` self-expansion
 * in `parseComposeEnvFile`) simply has nowhere to report, which is fine.
 */
const missingRequiredSinks = new WeakMap<Record<string, string>, Map<string, string | undefined>>();
const unresolvedVariableSinks = new WeakMap<Record<string, string>, Set<string>>();

function reportUnresolvedVariable(key: string, env: Record<string, string>): void {
  unresolvedVariableSinks.get(env)?.add(key);
}

function reportMissingRequired(
  key: string,
  rawWord: string,
  env: Record<string, string>,
): { value: string; source: "missing"; variable: string; required: true } {
  reportUnresolvedVariable(key, env);
  const sink = missingRequiredSinks.get(env);
  // First mention wins: the same variable is often required in several services
  // and the first message is as good as the last.
  if (sink && !sink.has(key)) sink.set(key, rawWord.trim() || undefined);
  return { value: "", source: "missing", variable: key, required: true };
}

/** Start diagnostics scoped to this one parse; unrelated interpolation cannot contribute. */
export function createComposeInterpolationDiagnostics(env: Record<string, string>) {
  const required = new Map<string, string | undefined>();
  missingRequiredSinks.set(env, required);
  return required;
}

export function parseComposeEnvFile(content: string): Record<string, string> {
  const entries = parseEnvFile(content);
  const result = Object.fromEntries(entries.map(({ key, value }) => [key, value]));
  const expressions = new Map<string, string>();
  for (const { key, interpolation } of entries) {
    if (interpolation === undefined) expressions.delete(key);
    else expressions.set(key, interpolation);
  }
  for (const key of Object.keys(result)) {
    const expression = expressions.get(key);
    if (expression !== undefined) result[key] = interpolateComposeString(expression, result);
  }
  return result;
}

const BARE_VARIABLE_RE = /^[A-Za-z_][A-Za-z0-9_]*/;

/**
 * Reads the `${...}` expression opening at `start`, counting nested `${` so the
 * matching close brace is found. Returns null when the expression is never closed.
 */
function readBracedExpression(
  input: string,
  start: number,
): { expression: string; end: number } | null {
  let depth = 1;
  for (let i = start + 2; i < input.length; i++) {
    if (input[i] === "$" && input[i + 1] === "{") {
      depth++;
      i++;
    } else if (input[i] === "}" && --depth === 0) {
      return { expression: input.slice(start + 2, i), end: i + 1 };
    }
  }
  return null;
}

export function interpolateComposeString(input: string, env: Record<string, string>): string {
  const escapedDollar = "\0COMPOSE_ESCAPED_DOLLAR\0";
  const protectedInput = input.replace(/\$\$/g, escapedDollar);

  let out = "";
  let cursor = 0;
  while (cursor < protectedInput.length) {
    const dollar = protectedInput.indexOf("$", cursor);
    if (dollar < 0) break;
    out += protectedInput.slice(cursor, dollar);
    cursor = dollar + 1;

    if (protectedInput[dollar + 1] === "{") {
      const braced = readBracedExpression(protectedInput, dollar);
      if (braced && braced.expression) {
        out += resolveInterpolationExpression(braced.expression, env).value;
        cursor = braced.end;
        continue;
      }
    } else {
      const bare = protectedInput.slice(dollar + 1).match(BARE_VARIABLE_RE);
      if (bare) {
        if (!Object.hasOwn(env, bare[0])) reportUnresolvedVariable(bare[0], env);
        out += env[bare[0]] ?? "";
        cursor = dollar + 1 + bare[0].length;
        continue;
      }
    }

    out += "$";
  }

  return (out + protectedInput.slice(cursor)).replaceAll(escapedDollar, "$");
}

export interface ComposeInterpolationResolution {
  value: string;
  /** Variables whose selected Compose branch had no value in this scope. */
  unresolvedVariables: string[];
  /** The unresolved subset declared mandatory with `:?` / `?`. */
  missingRequired: ComposeMissingVariable[];
}

/**
 * Resolve one Compose scalar while retaining enough diagnostics for a later
 * deployment stage to fail closed. Unlike the environment-map helper below,
 * this also reports ordinary `${VAR}` / `$VAR` misses: an empty runtime env is
 * legal, but an empty image tag must never be handed to a registry client that
 * silently rewrites it to `latest`.
 */
export function resolveComposeInterpolation(
  input: string,
  env: Record<string, string>,
): ComposeInterpolationResolution {
  const parentRequired = missingRequiredSinks.get(env);
  const parentUnresolved = unresolvedVariableSinks.get(env);
  const missingRequired = new Map<string, string | undefined>();
  const unresolved = new Set<string>();
  missingRequiredSinks.set(env, missingRequired);
  unresolvedVariableSinks.set(env, unresolved);

  try {
    return {
      value: interpolateComposeString(input, env),
      unresolvedVariables: [...unresolved],
      missingRequired: [...missingRequired].map(([variable, message]) => ({
        variable,
        ...(message && { message }),
      })),
    };
  } finally {
    if (parentRequired) {
      missingRequiredSinks.set(env, parentRequired);
      for (const [key, message] of missingRequired) {
        if (!parentRequired.has(key)) parentRequired.set(key, message);
      }
    } else {
      missingRequiredSinks.delete(env);
    }
    if (parentUnresolved) {
      unresolvedVariableSinks.set(env, parentUnresolved);
      for (const key of unresolved) parentUnresolved.add(key);
    } else {
      unresolvedVariableSinks.delete(env);
    }
  }
}

export function hasComposeInterpolation(input: string): boolean {
  return /\$\$|\$\{|\$[A-Za-z_]/.test(input);
}

function interpolateComposeStringWithMissing(
  input: string,
  env: Record<string, string>,
): { value: string; missing: Map<string, string | undefined> } {
  const resolution = resolveComposeInterpolation(input, env);
  const missing = new Map<string, string | undefined>();
  for (const { variable, message } of resolution.missingRequired) {
    missing.set(variable, message);
  }
  return { value: resolution.value, missing };
}

export interface ComposeEnvironmentResolution {
  env: Record<string, string>;
  missingRequired: ComposeMissingVariable[];
}

/**
 * Resolve persisted Compose environment expressions against the env that will
 * actually reach a service. Expressions may refer to another templated key, so
 * iterate to a fixed point instead of depending on YAML key order. Required
 * variables are reported only after convergence; callers can fail the service
 * without ever logging a value.
 */
export function resolveComposeEnvironmentTemplates(
  env: Record<string, string>,
  templates: Record<string, string>,
): ComposeEnvironmentResolution {
  const resolved = { ...env };
  const entries = Object.entries(templates);
  const evaluate = (key: string, expression: string) => {
    // A self-reference reads the lower-layer value, not the result we produced
    // on the previous fixed-point pass (`A=${A}x` must not grow x forever).
    const scope = { ...resolved };
    if (Object.hasOwn(env, key)) scope[key] = env[key]!;
    else delete scope[key];
    return interpolateComposeString(expression, scope);
  };

  for (let pass = 0; pass <= entries.length; pass++) {
    let changed = false;
    for (const [key, expression] of entries) {
      const value = evaluate(key, expression);
      if (resolved[key] !== value) {
        resolved[key] = value;
        changed = true;
      }
    }
    if (!changed) break;
  }

  const missing = new Map<string, string | undefined>();
  // One final stable pass records only requirements that remain unresolved.
  for (const [key, expression] of entries) {
    const scope = { ...resolved };
    if (Object.hasOwn(env, key)) scope[key] = env[key]!;
    else delete scope[key];
    const final = interpolateComposeStringWithMissing(expression, scope);
    resolved[key] = final.value;
    for (const [variable, message] of final.missing) {
      if (!missing.has(variable)) missing.set(variable, message);
    }
  }

  return {
    env: resolved,
    missingRequired: [...missing].map(([variable, message]) => ({
      variable,
      ...(message && { message }),
    })),
  };
}

export function resolveComposeValue(
  input: string,
  env: Record<string, string>,
): { value: string; meta?: ComposeEnvironmentMeta } {
  const trimmed = input.trim();
  const directBraced = trimmed.startsWith("${") ? readBracedExpression(trimmed, 0) : null;
  if (directBraced?.expression && directBraced.end === trimmed.length) {
    const resolved = resolveInterpolationExpression(directBraced.expression, env);
    return {
      value: resolved.value,
      meta: {
        source: resolved.source,
        variable: resolved.variable,
        defaultValue: resolved.defaultValue,
        resolvedValue: resolved.value,
        expression: trimmed,
        ...(resolved.required && { required: true }),
      },
    };
  }

  const directPlain = trimmed.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/);
  if (directPlain) {
    const key = directPlain[1]!;
    const resolved = resolveBareEnvironmentKey(key, env);
    return {
      value: resolved.value,
      meta: {
        source: resolved.meta?.source ?? "missing",
        variable: key,
        resolvedValue: resolved.value,
        expression: trimmed,
      },
    };
  }

  const { value, missing } = interpolateComposeStringWithMissing(input, env);
  if (!input.includes("$")) return { value };

  return {
    value,
    meta: {
      source: "interpolated",
      resolvedValue: value,
      expression: input,
      ...(missing.size > 0 && {
        required: true,
        unresolvedVariables: [...missing.keys()],
      }),
    },
  };
}

export function resolveBareEnvironmentKey(
  key: string,
  env: Record<string, string>,
): { value: string; meta: ComposeEnvironmentMeta } {
  const hasValue = Object.prototype.hasOwnProperty.call(env, key);
  const value = env[key] ?? "";
  return {
    value,
    meta: {
      source: hasValue ? "env-file" : "missing",
      variable: key,
      resolvedValue: value,
      expression: key,
    },
  };
}

function resolveInterpolationExpression(
  expression: string,
  env: Record<string, string>,
): {
  value: string;
  source: ComposeEnvironmentMeta["source"];
  variable?: string;
  defaultValue?: string;
  required?: boolean;
} {
  const match = expression.match(/^([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-+?])(.*))?$/s);
  if (!match) return { value: "", source: "missing" };

  const [, key, operator, rawWord = ""] = match;
  const hasValue = Object.prototype.hasOwnProperty.call(env, key);
  const value = env[key] ?? "";
  const isNonEmpty = hasValue && value !== "";
  const word = () => interpolateComposeString(rawWord, env);

  switch (operator) {
    case undefined:
      if (!hasValue) reportUnresolvedVariable(key, env);
      return {
        value: hasValue ? value : "",
        source: hasValue ? "env-file" : "missing",
        variable: key,
      };
    case ":-":
      if (isNonEmpty) return { value, source: "env-file", variable: key };
      {
        const fallback = word();
        return { value: fallback, source: "default", variable: key, defaultValue: fallback };
      }
    case "-":
      if (hasValue) return { value, source: "env-file", variable: key };
      {
        const fallback = word();
        return { value: fallback, source: "default", variable: key, defaultValue: fallback };
      }
    case ":?":
      if (isNonEmpty) return { value, source: "env-file", variable: key };
      return reportMissingRequired(key, rawWord, env);
    case "?":
      if (hasValue) return { value, source: "env-file", variable: key };
      return reportMissingRequired(key, rawWord, env);
    case ":+":
      if (!isNonEmpty) return { value: "", source: "missing", variable: key };
      {
        const replacement = word();
        return { value: replacement, source: "default", variable: key, defaultValue: replacement };
      }
    case "+":
      if (!hasValue) return { value: "", source: "missing", variable: key };
      {
        const replacement = word();
        return { value: replacement, source: "default", variable: key, defaultValue: replacement };
      }
    default:
      reportUnresolvedVariable(key, env);
      return { value: "", source: "missing", variable: key };
  }
}
