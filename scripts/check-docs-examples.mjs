/** Type-check documented SDK usage against the public package declarations. */
import ts from "typescript";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { docsDirectory, filesUnder, root } from "./docs-surface.mjs";

export function checkDocExamples() {
  const declarations = join(root, "packages/openship/dist/sdk/index.d.ts");
  if (!existsSync(declarations))
    throw new Error("Build the public package first: bun run build:sdk");
  const packageRequire = createRequire(join(root, "packages/openship/package.json"));
  const nodeTypesRoot = dirname(dirname(packageRequire.resolve("@types/node/package.json")));
  const snippets = new Map();
  for (const file of filesUnder(docsDirectory, ".mdx")) {
    const raw = readFileSync(file, "utf8");
    let index = 0;
    for (const match of raw.matchAll(
      /^```(ts|typescript|js|javascript)([^\n]*)\n([\s\S]*?)^```/gm,
    )) {
      const [, language, meta, source] = match;
      const sdkExample =
        /(?:from|import\()\s*["']openship(?:\/[^"']+)?["']/.test(source) ||
        /\b(?:ship|operator)\./.test(source) ||
        meta.includes("ship-native.config");
      if (!sdkExample) continue;
      // TypeScript examples are always checked. Check JavaScript SDK programs,
      // while browser scripts and shell commands remain in their own contexts.
      const javascript = ["js", "javascript"].includes(language);
      const filename = join(
        root,
        ".docs-examples",
        relative(docsDirectory, file).replaceAll("/", "__") +
          `-${++index}.${javascript ? "mjs" : "mts"}`,
      );
      let prelude = "export {};\n";
      if (
        !javascript &&
        /\bship\./.test(source) &&
        !/\b(?:const|let|var|class|function)\s+ship\b/.test(source)
      )
        prelude +=
          'declare const ship: import("openship").OpenshipClient | import("openship").ScopedShip;\n';
      if (
        !javascript &&
        /\boperator\./.test(source) &&
        !/\b(?:const|let|var|class|function)\s+operator\b/.test(source)
      )
        prelude += 'declare const operator: import("openship").OpenshipOperatorClient;\n';
      snippets.set(filename, {
        source: prelude + source,
        origin: relative(root, file),
        line: raw.slice(0, match.index).split("\n").length + 1,
        offset: prelude.split("\n").length - 1,
        title: meta,
      });
    }
  }
  const options = {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    types: ["node"],
    allowJs: true,
    checkJs: true,
    typeRoots: [nodeTypesRoot],
    paths: {
      openship: [declarations],
      "openship/client": [join(root, "packages/openship/dist/sdk/client.d.ts")],
      "openship/native": [join(root, "packages/openship/dist/sdk/native.d.ts")],
    },
  };
  const host = ts.createCompilerHost(options);
  const originalRead = host.readFile.bind(host);
  const originalExists = host.fileExists.bind(host);
  const originalSource = host.getSourceFile.bind(host);
  host.readFile = (file) => snippets.get(file)?.source ?? originalRead(file);
  host.fileExists = (file) => snippets.has(file) || originalExists(file);
  host.getSourceFile = (file, target, onError, createNew) =>
    snippets.has(file)
      ? ts.createSourceFile(file, snippets.get(file).source, target, true)
      : originalSource(file, target, onError, createNew);
  const program = ts.createProgram([...snippets.keys()], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length) {
    const errors = diagnostics.map((diagnostic) => {
      const source = diagnostic.file && snippets.get(diagnostic.file.fileName);
      const position = diagnostic.file?.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
      const location = source
        ? `${source.origin}:${source.line + (position?.line ?? 0) - source.offset}`
        : (diagnostic.file?.fileName ?? "TypeScript");
      return `${location}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`;
    });
    throw new Error(errors.join("\n"));
  }
  return snippets.size;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  console.log(`${checkDocExamples()} SDK/TypeScript documentation examples type-check.`);
