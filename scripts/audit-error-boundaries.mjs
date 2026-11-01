#!/usr/bin/env node
/** Static coverage ledger. This complements behavioral tests; it is not proof
 * that a provider can never throw or that an observer received a remote event. */
import { readFileSync, readdirSync } from "node:fs";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const roots = [
  "apps/api/src",
  "apps/dashboard/src",
  "apps/desktop/src",
  "apps/cli/src",
  "apps/web/src",
  "packages/core/src",
  "packages/platform/src",
  "packages/adapters/src",
  "packages/db/src",
  "packages/sdk/src",
  "packages/onboarding/src",
  "packages/contracts/src",
  "packages/ui/src",
  "packages/db-email/src",
];

const observed =
  /\b(?:reportError|reportCaughtError|observeCaughtError|reportClientError|reportCliMessage|noteApiError|handleApiError|logBillingFailure|reportFailure|failOperation|getApiErrorMessage|err)\s*\(|\b(?:errorDiagnostics|diagnostics)\.(?:warn|error)\s*\(/;
const machinery = new Set([
  "apps/api/src/middleware/error-observation.ts",
  "apps/api/src/lib/ws.ts",
  "apps/dashboard/src/lib/error-reporting.ts",
  "apps/cli/src/index.ts",
]);
// The recovery launcher must start before a supported Node or dependencies
// exist. It cannot load platform modules; its built-in-only gate tests enforce it.
const bootstrap = new Set([
  "apps/cli/src/node-entry.ts",
  "apps/cli/src/node-bootstrap.ts",
  "apps/cli/src/lib/node-runtime.ts",
]);

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return files(path);
    return /\.[cm]?[jt]sx?$/.test(entry.name) &&
      !/\.(?:test|spec|d)\.[cm]?[jt]sx?$/.test(entry.name)
      ? [path]
      : [];
  });
}

export function auditSource(file, code) {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
  const findings = [];
  const add = (node, kind, disposition) =>
    findings.push({
      file,
      line:
        source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      kind,
      disposition,
    });
  function classify(body, binding, tried = "") {
    const text = body.getText(source);
    if (observed.test(text)) return "observed";
    if (bootstrap.has(file)) return "pre-runtime-bootstrap";
    if (/diagnostics-ignore:\s*\S/.test(text)) return "documented-control-flow";
    if (
      file.startsWith("packages/core/src/diagnostics/") ||
      machinery.has(file)
    )
      return "reporter-boundary";
    if (binding && new RegExp(`\\bthrow\\s+${binding}\\b`).test(text))
      return "propagated";
    if (
      /JSON\.parse|new URL\(|decodeURIComponent|parseURL/.test(tried) &&
      !/\bawait\b|\bfetch\(|\.exec\(|\.run\(/.test(tried) &&
      !/\bthrow\b/.test(text)
    )
      return "parsing-fallback";
    if (/\bthrow\b|\b(?:reject|rej)\s*\(/.test(text)) return "propagated";
    return "unobserved";
  }
  const walk = (node) => {
    if (ts.isCatchClause(node))
      add(
        node,
        "catch",
        classify(
          node.block,
          node.variableDeclaration?.name.getText(source),
          node.parent.tryBlock.getText(source),
        ),
      );
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression)
    ) {
      const method = node.expression.name.text;
      if (
        method === "catch" ||
        (method === "then" && node.arguments.length > 1)
      ) {
        const handler = node.arguments[method === "catch" ? 0 : 1];
        if (
          handler &&
          (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler))
        ) {
          add(
            node,
            method === "catch" ? "promise-catch" : "promise-rejection",
            classify(handler.body, handler.parameters[0]?.name.getText(source)),
          );
        } else if (
          handler &&
          handler.kind !== ts.SyntaxKind.UndefinedKeyword &&
          handler.getText(source) !== "undefined"
        ) {
          add(node, "forwarded-rejection", "delegated");
        }
      }
      if (
        ["on", "once", "addEventListener"].includes(method) &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0]) &&
        ["error", "unhandledrejection"].includes(node.arguments[0].text)
      ) {
        const handler = node.arguments[1];
        add(
          node,
          "error-event",
          handler &&
            (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler))
            ? classify(
                handler.body,
                handler.parameters[0]?.name.getText(source),
              )
            : "delegated",
        );
      }
      if (
        node.expression.expression.getText(source) === "console" &&
        ["warn", "error"].includes(method)
      ) {
        add(
          node,
          "console",
          bootstrap.has(file)
            ? "pre-runtime-bootstrap"
            : file.startsWith("packages/core/src/diagnostics/") ||
                file === "apps/cli/src/lib/output.ts"
              ? "local-output"
              : "unstructured",
        );
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return findings;
}

export function audit() {
  return roots
    .flatMap((directory) => files(resolve(root, directory)))
    .sort()
    .flatMap((path) =>
      auditSource(relative(root, path), readFileSync(path, "utf8")),
    );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const findings = audit();
  const failures = findings.filter((row) =>
    ["unobserved", "unstructured"].includes(row.disposition),
  );
  const summary = {};
  for (const row of findings) {
    const group = roots.find((root) => row.file.startsWith(root));
    const counts = (summary[group] ??= {});
    counts[row.disposition] = (counts[row.disposition] ?? 0) + 1;
  }
  if (process.argv.includes("--routes")) {
    const { httpSurface } = await import("./docs-surface.mjs");
    process.stdout.write(
      JSON.stringify(
        httpSurface().map((route) => ({
          method: route.method,
          path: route.path,
          module: route.module,
          source: route.source,
          boundary: "observeRequestErrors",
          localOnly: route.localOnly,
        })),
        null,
        2,
      ) + "\n",
    );
  } else if (process.argv.includes("--json"))
    process.stdout.write(JSON.stringify({ summary, findings }, null, 2) + "\n");
  else {
    console.log(JSON.stringify(summary, null, 2));
    for (const row of failures)
      console.error(
        `${row.file}:${row.line}: ${row.kind} is ${row.disposition}`,
      );
    console.log(
      `${findings.length} error boundaries; ${failures.length} need a reporter, propagation, or a documented control-flow reason.`,
    );
    if (process.argv.includes("--check") && failures.length)
      process.exitCode = 1;
  }
}
