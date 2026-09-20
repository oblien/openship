/** Read route declarations without importing handlers or starting providers. */
import ts from "typescript";

const routerMetadata = Symbol("router metadata");
const methods = new Set(["get", "post", "patch", "put", "delete", "head", "options", "all"]);

/** Only resolve static values. Calls, imports and mutable bindings stay unresolved. */
function value(node, bindings) {
  if (!node) return undefined;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isIdentifier(node)) return bindings.get(node.text);
  if (
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isParenthesizedExpression(node)
  )
    return value(node.expression, bindings);
  if (ts.isArrayLiteralExpression(node))
    return node.elements.map((entry) => value(entry, bindings));
  if (ts.isTemplateExpression(node)) {
    let text = node.head.text;
    for (const span of node.templateSpans) {
      const part = value(span.expression, bindings);
      if (typeof part !== "string" && typeof part !== "number") return undefined;
      text += part + span.literal.text;
    }
    return text;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = value(node.left, bindings);
    const right = value(node.right, bindings);
    if ([left, right].every((part) => typeof part === "string" || typeof part === "number"))
      return left + right;
  }
  if (ts.isObjectLiteralExpression(node)) {
    const result = Object.create(null);
    for (const property of node.properties) {
      if (ts.isSpreadAssignment(property)) {
        const spread = value(property.expression, bindings);
        if (!spread || typeof spread !== "object" || Array.isArray(spread)) return undefined;
        Object.assign(result, spread);
      } else {
        const name = ts.isIdentifier(property.name)
          ? property.name.text
          : value(property.name, bindings);
        if (typeof name !== "string") return undefined;
        result[name] = value(
          ts.isShorthandPropertyAssignment(property)
            ? property.name
            : ts.isPropertyAssignment(property)
              ? property.initializer
              : undefined,
          bindings,
        );
      }
    }
    return result;
  }
  return undefined;
}

function bind(pattern, resolved, bindings) {
  if (ts.isIdentifier(pattern)) bindings.set(pattern.text, resolved);
  else if (ts.isArrayBindingPattern(pattern)) {
    pattern.elements.forEach((element, index) => {
      if (ts.isBindingElement(element))
        bind(
          element.name,
          Array.isArray(resolved) && !element.dotDotDotToken ? resolved[index] : undefined,
          bindings,
        );
    });
  } else if (ts.isObjectBindingPattern(pattern)) {
    // Unsupported bindings still shadow outer names; never borrow another scope's router.
    for (const element of pattern.elements) bind(element.name, undefined, bindings);
  }
}

export function moduleHttpSurface(file, text, mounts = new Map()) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const routes = [];
  const fail = (message, node) => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    throw new Error(`${message} in ${file}:${line}: ${node.getText(source)}`);
  };

  function visit(node, bindings, unresolvedLoop = false) {
    if (ts.isSourceFile(node) || ts.isBlock(node) || ts.isFunctionLike(node))
      bindings = new Map(bindings);
    if (ts.isFunctionLike(node))
      for (const parameter of node.parameters) bind(parameter.name, undefined, bindings);

    if (ts.isForOfStatement(node)) {
      const declaration =
        ts.isVariableDeclarationList(node.initializer) &&
        node.initializer.flags & ts.NodeFlags.Const &&
        node.initializer.declarations[0];
      const entries = value(node.expression, bindings);
      if (declaration && Array.isArray(entries)) {
        for (const entry of entries) {
          const iteration = new Map(bindings);
          bind(declaration.name, entry, iteration);
          visit(node.statement, iteration, unresolvedLoop);
        }
      } else visit(node.statement, new Map(bindings), true);
      return;
    }

    if (ts.isVariableDeclaration(node)) {
      const constant =
        ts.isVariableDeclarationList(node.parent) && node.parent.flags & ts.NodeFlags.Const;
      let resolved = constant ? value(node.initializer, bindings) : undefined;
      if (constant && ts.isIdentifier(node.name) && node.initializer) {
        const init = node.initializer;
        if (ts.isCallExpression(init) && init.expression.getText(source) === "secureRouter") {
          const options = value(init.arguments[1], bindings);
          if (
            typeof options?.basePath !== "string" ||
            !options.basePath ||
            typeof options?.module !== "string" ||
            !options.module ||
            (Object.hasOwn(options, "localOnly") && typeof options.localOnly !== "boolean")
          )
            fail("Unresolved route metadata", init);
          resolved = { [routerMetadata]: options };
        } else if (
          ts.isNewExpression(init) &&
          init.expression.getText(source) === "Hono" &&
          mounts.has(node.name.text)
        ) {
          const basePath = mounts.get(node.name.text);
          resolved = { [routerMetadata]: { basePath, module: basePath.split("/")[2], raw: true } };
        }
      }
      bind(node.name, resolved, bindings);
    }

    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const router = value(node.expression.expression, bindings)?.[routerMetadata];
      if (router) {
        const operation = node.expression.name.text;
        const explicitMethod = operation === "public" || operation === "on";
        if (explicitMethod || methods.has(operation)) {
          if (unresolvedLoop) fail("Unresolved route loop", node);
          const declared = explicitMethod ? value(node.arguments[0], bindings) : operation;
          const verbs = Array.isArray(declared) ? declared : [declared];
          if (
            !verbs.length ||
            !verbs.every((verb) => typeof verb === "string" && methods.has(verb.toLowerCase()))
          )
            fail("Unresolved route method", node);
          const path = value(node.arguments[explicitMethod ? 1 : 0], bindings);
          if (typeof path !== "string") fail("Unresolved route path", node);
          const spec = value(node.arguments[explicitMethod ? 2 : 1], bindings);
          const tag = spec?.tag;
          if (!router.raw && operation !== "public" && typeof tag !== "string")
            fail("Unresolved route permission", node);
          if (spec && Object.hasOwn(spec, "localOnly") && typeof spec.localOnly !== "boolean")
            fail("Unresolved route availability", node);
          const internal = node.arguments.some(
            (argument) => argument.getText(source) === "internalAuth",
          );
          for (const verb of verbs)
            routes.push({
              method: verb.toUpperCase(),
              path: (router.basePath + (path === "/" ? "" : path)).replace(/\/$/, ""),
              module: router.module,
              access: internal
                ? "Internal operator"
                : (tag ??
                  (router.module === "health"
                    ? "Public"
                    : router.module === "images"
                      ? "Authenticated"
                      : "Handler authentication")),
              localOnly: !!(router.localOnly || spec?.localOnly),
              source: file,
            });
        }
      }
    }
    ts.forEachChild(node, (child) => visit(child, bindings, unresolvedLoop));
  }
  visit(source, new Map());
  return routes;
}
