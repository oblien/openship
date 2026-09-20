/** Literal source comparison for the relocation audit; never edits either input. */
import ts from "typescript";

export function moduleSpecifierLiteral(node) {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier &&
    ts.isStringLiteral(node.moduleSpecifier)
  )
    return node.moduleSpecifier;
  if (
    ts.isCallExpression(node) &&
    (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
    node.arguments[0] &&
    ts.isStringLiteral(node.arguments[0])
  )
    return node.arguments[0];
  return null;
}

function withoutModuleSpecifierContents(file, bytes) {
  const text = bytes.toString("utf8");
  // Decoding must not collapse different invalid byte sequences into U+FFFD.
  if (!Buffer.from(text, "utf8").equals(bytes)) return null;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  if (source.parseDiagnostics.length) return null;
  const spans = [];
  function visit(node) {
    const literal =
      moduleSpecifierLiteral(node) ??
      (ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
        ? node.argument.literal
        : null);
    if (literal) spans.push([literal.getStart(source) + 1, literal.getEnd() - 1]);
    ts.forEachChild(node, visit);
  }
  visit(source);
  spans.sort((a, b) => a[0] - b[0]);
  let cursor = 0;
  const parts = [];
  for (const [start, end] of spans) {
    parts.push(text.slice(cursor, start), "<MODULE_SPECIFIER>");
    cursor = end;
  }
  parts.push(text.slice(cursor));
  return parts.join("");
}

/** Path-only means only literal module strings differ, not that their targets are equivalent. */
export function classifySourceText(beforeFile, before, afterFile, after) {
  if (before.equals(after)) return "byte-identical";
  const previous = withoutModuleSpecifierContents(beforeFile, before);
  const current = withoutModuleSpecifierContents(afterFile, after);
  return previous !== null && current !== null && previous === current
    ? "module-specifiers-only"
    : "other-text-changes";
}
