import { data, Evaluator, Lexer, Parser, type Expr } from "@actions/expressions";
import {
  Binary,
  FunctionCall,
  Grouping,
  IndexAccess,
  Logical,
  Unary,
} from "@actions/expressions/ast";
import type { FunctionDefinition } from "@actions/expressions/funcs/info";
import { truthy } from "@actions/expressions/result";
import { ValidationError } from "@repo/core";

export interface ActionExpressionContext {
  github: Record<string, unknown>;
  needs?: Record<string, unknown>;
  matrix?: Record<string, unknown>;
  strategy?: Record<string, unknown>;
  inputs?: Record<string, unknown>;
  vars?: Record<string, string>;
  cancelled?: boolean;
  failed?: boolean;
}

function functions(ctx: ActionExpressionContext): Map<string, FunctionDefinition> {
  const needs = Object.values(ctx.needs ?? {}) as { result?: string }[];
  const values = {
    always: true,
    cancelled: !!ctx.cancelled,
    failure: !!ctx.failed || needs.some((n) => n.result === "failure" || n.result === "timed_out"),
    success: !ctx.cancelled && needs.every((n) => n.result === "success"),
  };
  return new Map(
    Object.entries(values).map(([name, value]) => [
      name,
      { name, minArgs: 0, maxArgs: 0, call: () => new data.BooleanData(value) },
    ]),
  );
}

function parse(source: string, ctx: ActionExpressionContext) {
  if (source.length > 20_000) throw new ValidationError("Actions expression is too large");
  const values = {
    github: ctx.github,
    needs: ctx.needs ?? {},
    matrix: ctx.matrix ?? {},
    strategy: ctx.strategy ?? {},
    inputs: ctx.inputs ?? {},
    vars: ctx.vars ?? {},
  };
  const fns = functions(ctx);
  const tree = new Parser(new Lexer(source).lex().tokens, Object.keys(values), [
    ...fns.values(),
  ]).parse();
  const dictionary = JSON.parse(JSON.stringify(values), data.reviver) as data.Dictionary;
  return { tree, evaluator: new Evaluator(tree, dictionary, fns) };
}

function statusFunction(tree: Expr): boolean {
  if (tree instanceof FunctionCall)
    return (
      ["success", "failure", "always", "cancelled"].includes(
        tree.functionName.lexeme.toLowerCase(),
      ) || tree.args.some(statusFunction)
    );
  if (tree instanceof Binary) return statusFunction(tree.left) || statusFunction(tree.right);
  if (tree instanceof Logical) return tree.args.some(statusFunction);
  if (tree instanceof Grouping) return statusFunction(tree.group);
  if (tree instanceof IndexAccess) return statusFunction(tree.expr) || statusFunction(tree.index);
  if (tree instanceof Unary) return statusFunction(tree.expr);
  return false;
}

export function evaluateJobCondition(
  value: string | boolean | undefined,
  ctx: ActionExpressionContext,
): boolean {
  if (typeof value === "boolean")
    return value && functions(ctx).get("success")!.call().coerceString() === "true";
  const source = (value?.trim() || "success()").replace(/^\$\{\{([\s\S]*)\}\}$/, "$1");
  const { tree, evaluator } = parse(source, ctx);
  if (!statusFunction(tree) && !truthy(functions(ctx).get("success")!.call())) return false;
  return truthy(evaluator.evaluate());
}

/** Parse expression boundaries without treating }} inside a quoted string as a terminator. */
function segments(value: string): Array<{ literal: string } | { expression: string }> {
  const result: Array<{ literal: string } | { expression: string }> = [];
  let cursor = 0;
  for (;;) {
    const start = value.indexOf("${{", cursor);
    if (start < 0) {
      if (cursor < value.length) result.push({ literal: value.slice(cursor) });
      break;
    }
    if (start > cursor) result.push({ literal: value.slice(cursor, start) });
    let quoted = false;
    let end = start + 3;
    for (; end < value.length - 1; end++) {
      if (value[end] === "'") {
        if (quoted && value[end + 1] === "'") {
          end++;
          continue;
        }
        quoted = !quoted;
      }
      if (!quoted && value.slice(end, end + 2) === "}}") break;
    }
    if (end >= value.length - 1) throw new ValidationError("Unclosed Actions expression");
    result.push({ expression: value.slice(start + 3, end) });
    cursor = end + 2;
  }
  return result;
}

export function evaluateTemplate(value: unknown, ctx: ActionExpressionContext, depth = 0): unknown {
  if (depth > 20) throw new ValidationError("Actions expression nesting is too deep");
  if (Array.isArray(value)) return value.map((v) => evaluateTemplate(v, ctx, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, evaluateTemplate(v, ctx, depth + 1)]),
    );
  if (typeof value !== "string" || !value.includes("${{")) return value;
  const parts = segments(value);
  if (parts.length === 1 && "expression" in parts[0]!) {
    return JSON.parse(
      JSON.stringify(parse(parts[0].expression, ctx).evaluator.evaluate(), data.replacer),
    );
  }
  return parts
    .map((part) =>
      "literal" in part
        ? part.literal
        : parse(part.expression, ctx).evaluator.evaluate().coerceString(),
    )
    .join("");
}
