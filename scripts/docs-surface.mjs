/** Read public interfaces and command help without starting an installation. */
import ts from "typescript";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { moduleHttpSurface } from "./docs-http.mjs";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const docsDirectory = join(root, "apps/web/content/docs");
const execute = promisify(execFile);

export function filesUnder(directory, extension) {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

export function sdkSurface() {
  const configPath = join(root, "packages/sdk/tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error)
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath));
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(join(root, "packages/sdk/src/native.ts"));
  const declaration = source?.statements.find(
    (node) => ts.isInterfaceDeclaration(node) && node.name.text === "ScopedShip",
  );
  if (!declaration) throw new Error("Cannot find the public ScopedShip interface");
  function argumentsFor(parameter) {
    const type = checker.getTypeOfSymbolAtLocation(parameter, declaration);
    if (parameter.valueDeclaration?.dotDotDotToken && checker.isTupleType(type)) {
      // Mapped operations use (...args: [] | [input] | [input?]). Document the
      // resolved tuple, not a fictitious argument literally named "args".
      return checker.getTypeArguments(type).map((_, index) => {
        const label = type.target.labeledElementDeclarations?.[index]?.name?.getText();
        const flags = type.target.elementFlags[index];
        return (
          (flags & ts.ElementFlags.Rest ? "..." : "") +
          (label ?? `input${index || ""}`) +
          (flags & ts.ElementFlags.Optional ? "?" : "")
        );
      });
    }
    return [
      parameter.name +
        (parameter.flags & ts.SymbolFlags.Optional || parameter.valueDeclaration?.questionToken
          ? "?"
          : ""),
    ];
  }
  return checker
    .getTypeAtLocation(declaration)
    .getProperties()
    .filter((property) => !["deploy", "deployment", "organizationId"].includes(property.name))
    .map((property) => ({
      group: property.name,
      methods: checker
        .getTypeOfSymbolAtLocation(property, declaration)
        .getProperties()
        .map((method) => ({
          name: method.name,
          calls: checker
            .getTypeOfSymbolAtLocation(method, declaration)
            .getCallSignatures()
            .map(
              (signature) =>
                `${method.name}(${signature.parameters.flatMap(argumentsFor).join(", ")})`,
            ),
        })),
    }));
}

function helpRows(lines) {
  const result = [];
  for (const line of lines) {
    const match = line.match(/^  (\S.*?)\s{2,}(\S.*)$/);
    if (match) result.push({ syntax: match[1], description: match[2] });
    else if (/^    +\S/.test(line) && result.length) result.at(-1).description += " " + line.trim();
    else if (/^  \S/.test(line)) result.push({ syntax: line.trim(), description: "" });
  }
  return result;
}

export async function cliSurface() {
  const binary = join(root, "packages/openship/dist/node-entry.js");
  const catalog = [];
  async function visit(parts) {
    const { stdout } = await execute(process.execPath, [binary, ...parts, "--help"], {
      cwd: root,
      timeout: 30_000,
      maxBuffer: 1_000_000,
    });
    // Working-directory defaults are not part of the public command contract.
    const help = stdout.replaceAll(root, ".");
    if (!help.startsWith("Usage: openship"))
      throw new Error(`Unexpected help for openship ${parts.join(" ")}`);
    const sections = { introduction: [] };
    let section = "introduction";
    for (const line of help.split("\n")) {
      if (/^[A-Z][\w ]+:$/.test(line)) {
        section = line.slice(0, -1);
        sections[section] = [];
      } else sections[section].push(line);
    }
    const children = helpRows(sections.Commands ?? []).filter(
      (row) => !row.syntax.startsWith("help "),
    );
    catalog.push({
      command: ["openship", ...parts].join(" "),
      usage: help.split("\n")[0].replace(/^Usage: /, ""),
      description: sections.introduction.slice(1).join(" ").trim(),
      arguments: helpRows(sections.Arguments ?? []),
      options: helpRows(sections.Options ?? []),
      children,
    });
    for (let i = 0; i < children.length; i += 4)
      await Promise.all(
        children.slice(i, i + 4).map((row) => visit([...parts, row.syntax.split(/[ |]/)[0]])),
      );
  }
  await visit([]);
  return catalog.sort((a, b) => a.command.localeCompare(b.command));
}

/** Static route inventory: importing the API would initialize real providers. */
export function httpSurface() {
  const routes = [];
  const literal = (node) => (node && ts.isStringLiteralLike(node) ? node.text : undefined);
  const visit = (node, fn) => {
    fn(node);
    ts.forEachChild(node, (child) => visit(child, fn));
  };
  const appFile = join(root, "apps/api/src/app.ts");
  const app = ts.createSourceFile(
    appFile,
    readFileSync(appFile, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  // Browser callback and OAuth discovery routes are mounted at the origin root.
  // Resolve the two explicit MCP resource aliases without importing the app.
  const resourceFile = join(root, "apps/api/src/lib/mcp-resource.ts");
  const resources = ts.createSourceFile(
    resourceFile,
    readFileSync(resourceFile, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const constants = new Map();
  visit(resources, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
      constants.set(node.name.text, node.initializer);
  });
  const constant = (node) => {
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isArrayLiteralExpression(node)) return node.elements.map(constant);
    if (ts.isIdentifier(node) && constants.has(node.text))
      return constant(constants.get(node.text));
    throw new Error(`Unresolved discovery path in ${relative(root, resourceFile)}`);
  };
  visit(app, (node) => {
    if (
      !ts.isCallExpression(node) ||
      !ts.isPropertyAccessExpression(node.expression) ||
      node.expression.expression.getText(app) !== "app"
    )
      return;
    const method = node.expression.name.text.toUpperCase();
    if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(method)) return;
    const path = node.arguments[0];
    let paths;
    if (literal(path)) paths = [literal(path)];
    else if (
      ts.isTemplateExpression(path) &&
      path.templateSpans.length === 1 &&
      path.templateSpans[0].expression.getText(app) === "path"
    ) {
      let parent = node.parent;
      while (parent && !ts.isForOfStatement(parent)) parent = parent.parent;
      if (!parent || parent.expression.getText(app) !== "MCP_RESOURCE_PATHS")
        throw new Error("Unresolved root route loop");
      paths = constant(constants.get("MCP_RESOURCE_PATHS")).map(
        (value) => path.head.text + value + path.templateSpans[0].literal.text,
      );
    } else throw new Error(`Unresolved root route: ${path.getText(app)}`);
    for (const path of paths)
      routes.push({
        method,
        path,
        module: "auth",
        access: path.startsWith("/.well-known/") ? "Public" : "Browser callback",
        localOnly: false,
        source: relative(root, appFile),
      });
  });
  const mounts = new Map();
  visit(app, (node) => {
    if (ts.isCallExpression(node) && node.expression.getText(app) === "app.route") {
      const path = literal(node.arguments[0]);
      if (path && ts.isIdentifier(node.arguments[1])) mounts.set(node.arguments[1].text, path);
    }
  });
  for (const file of filesUnder(join(root, "apps/api/src"), ".ts").filter(
    (file) => !file.endsWith(".test.ts"),
  )) {
    const text = readFileSync(file, "utf8");
    if (!text.includes("secureRouter") && !text.includes("new Hono")) continue;
    routes.push(...moduleHttpSurface(relative(root, file), text, mounts));
  }
  return routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}
