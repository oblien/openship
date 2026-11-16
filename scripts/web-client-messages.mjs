import { readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { messageKey } from "../apps/web/src/i18n/copy-key.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const web = path.join(root, "apps/web");
const sourceRoot = path.join(web, "src");
export const outputPath = path.join(sourceRoot, "i18n/client-message-keys.json");

/** Collect literals in client entry points and their local dependencies, including shared UI/data.
 * Server-fed presentation data must be translated before crossing the client boundary.
 * The output contains identifiers only; the normal locale catalog remains the source of truth.
 */
export function collectClientMessageKeys() {
  const config = ts.readConfigFile(path.join(web, "tsconfig.json"), ts.sys.readFile);
  const { options } = ts.parseJsonConfigFileContent(config.config, ts.sys, web);
  const english = JSON.parse(
    readFileSync(path.join(sourceRoot, "i18n/messages/en.json"), "utf8"),
  ).Copy;
  const visited = new Set();
  const keys = new Set();
  function visit(filename) {
    filename = realpathSync(filename);
    if (
      visited.has(filename) ||
      filename.includes("/node_modules/") ||
      !filename.startsWith(root + path.sep) ||
      !/\.[jt]sx?$/.test(filename) ||
      filename.endsWith(".d.ts")
    )
      return;
    visited.add(filename);
    const source = ts.createSourceFile(
      filename,
      readFileSync(filename, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    function walk(node) {
      if (ts.isStringLiteralLike(node) || ts.isJsxText(node)) {
        const key = messageKey(node.text);
        if (english[key]) keys.add(key);
      }
      if (
        (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) ||
        (ts.isExportDeclaration(node) && !node.isTypeOnly)
      ) {
        const specifier = node.moduleSpecifier;
        if (specifier && ts.isStringLiteral(specifier)) {
          const resolved = ts.resolveModuleName(
            specifier.text,
            filename,
            options,
            ts.sys,
          ).resolvedModule;
          if (resolved) visit(resolved.resolvedFileName);
        }
      }
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        const resolved = ts.resolveModuleName(
          node.arguments[0].text,
          filename,
          options,
          ts.sys,
        ).resolvedModule;
        if (resolved) visit(resolved.resolvedFileName);
      }
      ts.forEachChild(node, walk);
    }
    walk(source);
  }
  function findEntries(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) findEntries(filename);
      else if (
        /\.[jt]sx?$/.test(filename) &&
        !filename.endsWith(".d.ts") &&
        /^\s*["']use client["'];/m.test(readFileSync(filename, "utf8"))
      )
        visit(filename);
    }
  }
  findEntries(sourceRoot);
  return [...keys].sort();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeFileSync(outputPath, JSON.stringify(collectClientMessageKeys(), null, 2) + "\n");
}
