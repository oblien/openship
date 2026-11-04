#!/usr/bin/env node
/** Review ledger for process launches in shipped source. Complements the runtime
 * Cloud floor: this detects new launch sites, not input taint or exploitability. */
import { readFileSync, readdirSync } from "node:fs";
import { resolve, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const commands = new Set([
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "spawn",
  "spawnSync",
  "fork",
]);
const moduleNames = new Set(["child_process", "node:child_process"]);

export function auditProcessSource(file, text) {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    /\.[jt]sx(?:#|$)/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const bindings = new Map();
  const namespaces = new Set();
  const found = [];
  const visit = (node, work) => {
    work(node);
    ts.forEachChild(node, (child) => visit(child, work));
  };
  const childModule = (node) => {
    if (ts.isAwaitExpression(node) || ts.isParenthesizedExpression(node))
      return childModule(node.expression);
    return (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        node.expression.getText(source) === "require") &&
      ts.isStringLiteral(node.arguments[0]) &&
      moduleNames.has(node.arguments[0].text)
    );
  };
  const bind = (clause) => {
    if (ts.isIdentifier(clause)) namespaces.add(clause.text);
    else if (ts.isObjectBindingPattern(clause) || ts.isNamedImports(clause)) {
      for (const part of clause.elements) {
        const api = (part.propertyName ?? part.name).text;
        if (commands.has(api)) bindings.set(part.name.text, api);
      }
    }
  };
  visit(source, (node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      moduleNames.has(node.moduleSpecifier.text)
    ) {
      const clause = node.importClause;
      if (clause?.name) namespaces.add(clause.name.text);
      if (clause?.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings))
          namespaces.add(clause.namedBindings.name.text);
        else bind(clause.namedBindings);
      }
    }
    if (
      ts.isImportDeclaration(node) &&
      node.moduleSpecifier.text === "bun" &&
      node.importClause?.namedBindings &&
      ts.isNamedImports(node.importClause.namedBindings)
    ) {
      for (const part of node.importClause.namedBindings.elements) {
        const name = (part.propertyName ?? part.name).text;
        if (["spawn", "spawnSync", "$"].includes(name)) bindings.set(part.name.text, `Bun.${name}`);
      }
    }
    if (ts.isVariableDeclaration(node) && node.initializer && childModule(node.initializer))
      bind(node.name);
  });
  // Include common promisify/identifier aliases, including aliases of aliases.
  for (let pass = 0; pass < 3; pass++)
    visit(source, (node) => {
      if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer)
        return;
      let value = node.initializer;
      if (ts.isCallExpression(value) && /(?:^|\.)promisify$/.test(value.expression.getText(source)))
        value = value.arguments[0];
      if (value && ts.isIdentifier(value) && bindings.has(value.text))
        bindings.set(node.name.text, bindings.get(value.text));
      if (
        value &&
        ts.isPropertyAccessExpression(value) &&
        (namespaces.has(value.expression.getText(source)) || childModule(value.expression)) &&
        commands.has(value.name.text)
      )
        bindings.set(node.name.text, value.name.text);
    });
  const scope = (node) => {
    for (let at = node.parent; at; at = at.parent) {
      if (ts.isMethodDeclaration(at) || ts.isConstructorDeclaration(at)) {
        const owner = at.parent?.name?.text ?? "object";
        return `${owner}.${ts.isConstructorDeclaration(at) ? "constructor" : at.name.getText(source)}`;
      }
      if (ts.isFunctionDeclaration(at) && at.name) return at.name.text;
      if (
        (ts.isArrowFunction(at) || ts.isFunctionExpression(at)) &&
        ts.isVariableDeclaration(at.parent)
      )
        return at.parent.name.getText(source);
    }
    return "module";
  };
  visit(source, (node) => {
    if (
      !ts.isCallExpression(node) &&
      !ts.isNewExpression(node) &&
      !ts.isTaggedTemplateExpression(node)
    )
      return;
    const callee = ts.isTaggedTemplateExpression(node) ? node.tag : node.expression;
    let api;
    if (ts.isIdentifier(callee)) api = bindings.get(callee.text);
    if (ts.isPropertyAccessExpression(callee)) {
      const owner = callee.expression.getText(source),
        name = callee.name.text;
      if ((namespaces.has(owner) || childModule(callee.expression)) && commands.has(name))
        api = name;
      if (owner === "Bun" && ["spawn", "spawnSync", "$"].includes(name)) api = `Bun.${name}`;
      if (owner === "Deno" && name === "Command") api = "Deno.Command";
    }
    if (api) found.push({ file, scope: scope(node), api });
  });
  // A native harness wrapper is shipped as JavaScript source inside a string.
  visit(source, (node) => {
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      /(?:node:)?child_process/.test(node.text)
    ) {
      const owner = ts.isVariableDeclaration(node.parent)
        ? node.parent.name.getText(source)
        : "embedded";
      if (/\b(?:import|require)\b/.test(node.text))
        found.push(...auditProcessSource(`${file}#${owner}`, node.text));
    }
  });
  return found;
}

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory())
      return [
        "node_modules",
        "test",
        "tests",
        "__tests__",
        "fixtures",
        "dist",
        "build",
        "scripts",
        ".next",
        ".turbo",
        "coverage",
      ].includes(entry.name)
        ? []
        : sourceFiles(path);
    return /\.[cm]?[jt]sx?$/.test(entry.name) &&
      !/\.(test|spec)\./.test(entry.name) &&
      !entry.name.endsWith(".d.ts")
      ? [path]
      : [];
  });
}
export function collectProcessSites(base = root) {
  const files = ["apps", "packages"].flatMap((group) => sourceFiles(resolve(base, group)));
  const counts = new Map();
  for (const path of files)
    for (const site of auditProcessSource(
      relative(base, path).replaceAll("\\", "/"),
      readFileSync(path, "utf8"),
    )) {
      const key = `${site.file}:${site.scope}:${site.api}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  return {
    files: files.length,
    sites: [...counts]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, count]) => ({ key, count })),
  };
}
export function unreviewedProcessSites(actual, reviewed) {
  return actual.filter(
    (site) =>
      !reviewed.some(
        (row) => row.key === site.key && row.count === site.count && row.boundary?.trim(),
      ),
  );
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const result = collectProcessSites();
  if (process.argv.includes("--json")) console.log(JSON.stringify(result, null, 2));
  else {
    const ledger = JSON.parse(
      readFileSync(resolve(root, "scripts/process-execution-boundaries.json"), "utf8"),
    );
    const reviewed = Object.entries(ledger).flatMap(([file, entry]) =>
      Object.entries(entry.sites).map(([signature, count]) => ({
        key: `${file}:${signature}`,
        count,
        boundary: entry.boundary,
      })),
    );
    const pending = unreviewedProcessSites(result.sites, reviewed);
    const stale = reviewed.filter(
      (row) => !result.sites.some((site) => site.key === row.key && site.count === row.count),
    );
    if (pending.length || stale.length) {
      console.error(
        "Unreviewed process launches. Resolve the tenant/host boundary before updating the ledger:\n" +
          JSON.stringify({ pending, stale }, null, 2),
      );
      process.exitCode = 1;
    } else
      console.log(
        `${result.files} source files scanned; ${result.sites.reduce((sum, site) => sum + site.count, 0)} process launch sites match reviewed boundaries.`,
      );
  }
}
