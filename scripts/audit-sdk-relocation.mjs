/** Compare the SDK relocation with Git originals; never modifies source or the index. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { classifySourceText, moduleSpecifierLiteral } from "./sdk-relocation-compare.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const baselineArgument = process.argv.find((arg) => arg.startsWith("--baseline="))?.slice(11);
const baselineReportPath = process.argv
  .find((arg) => arg.startsWith("--baseline-report="))
  ?.slice(18);
if (baselineArgument && baselineReportPath)
  throw new Error("Choose --baseline or --baseline-report, not both.");
const baselineReport = baselineReportPath
  ? JSON.parse(readFileSync(resolve(baselineReportPath), "utf8"))
  : null;
if (
  baselineReport &&
  (baselineReport.formatVersion !== 2 ||
    !Array.isArray(baselineReport.fileDetails) ||
    !Array.isArray(baselineReport.baselineApiFiles) ||
    !baselineReport.baselineGitHead)
)
  throw new Error(
    "The baseline report must include pinned source blobs and the API source inventory.",
  );
const baseline = baselineReportPath
  ? `report:${baselineReportPath}`
  : (baselineArgument ?? "index");
const output = process.argv.find((arg) => arg.startsWith("--json="))?.slice(7);
const moves = JSON.parse(readFileSync(join(root, "docs/ship-sdk-relocations.json"), "utf8"));
const forward = new Map(moves.map((move) => [resolve(root, move.from), resolve(root, move.to)]));
const reverse = new Map([...forward].map(([from, to]) => [to, from]));
const gitHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const baselineGitHead =
  baselineReport?.baselineGitHead ??
  (baseline === "index"
    ? gitHead
    : execFileSync("git", ["rev-parse", `${baseline}^{commit}`], {
        cwd: root,
        encoding: "utf8",
      }).trim());
function committedApiFilesAt(commit) {
  return new Map(
    execFileSync("git", ["ls-tree", "-r", "-z", commit, "--", "apps/api/src"], {
      cwd: root,
      encoding: "utf8",
    })
      .split("\0")
      .filter(Boolean)
      .map((entry) => {
        const split = entry.indexOf("\t");
        return [entry.slice(split + 1), entry.slice(0, split).split(" ")[2]];
      }),
  );
}
const committedApiFiles = committedApiFilesAt(baselineGitHead);
// A rebase can introduce a new API file after the original migration checkpoint.
// Pin its own committed baseline without replacing the older files' evidence.
const additionalBaselines = new Map();
for (const { baselineCommit } of moves) {
  if (!baselineCommit || additionalBaselines.has(baselineCommit)) continue;
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baselineCommit))
    throw new Error("Per-file baselines must use a full immutable commit ID.");
  additionalBaselines.set(baselineCommit, committedApiFilesAt(baselineCommit));
}
const originalApiFiles =
  baselineReport?.baselineApiFiles ??
  [
    ...new Set([
      ...committedApiFiles.keys(),
      ...(baseline === "index"
        ? execFileSync("git", ["ls-files", "-z", "--", "apps/api/src"], {
            cwd: root,
            encoding: "utf8",
          })
            .split("\0")
            .filter(Boolean)
        : []),
    ]),
  ].sort();
const baselineApiFiles = [
  ...new Set([
    ...originalApiFiles,
    ...[...additionalBaselines.values()].flatMap((files) => [...files.keys()]),
  ]),
].sort();
const pinnedFiles = new Map(baselineReport?.fileDetails.map((file) => [file.from, file]) ?? []);
const tracked = new Set(
  [
    ...execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
      .split("\0")
      .filter(Boolean),
    ...baselineApiFiles,
  ].map((path) => resolve(root, path)),
);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function resolveLocal(file, specifier) {
  let base;
  if (specifier.startsWith(".")) base = resolve(dirname(file), specifier);
  else if (specifier.startsWith("@repo/platform/engine/"))
    base = join(
      root,
      "packages/platform/src/engine",
      specifier.slice("@repo/platform/engine/".length),
    );
  else if (specifier.startsWith("@/")) base = join(root, "apps/api/src", specifier.slice(2));
  else return null;
  const candidates = [base + ".ts", base + ".tsx", join(base, "index.ts"), base];
  if (base.endsWith(".js")) candidates.unshift(base.slice(0, -3) + ".ts");
  return (
    candidates.find(
      (path) => forward.has(path) || reverse.has(path) || tracked.has(path) || existsSync(path),
    ) ?? base
  );
}

function moduleKey(file, specifier) {
  const resolved = resolveLocal(file, specifier);
  return resolved ? relative(root, reverse.get(resolved) ?? resolved) : specifier;
}

function moduleSpecifier(node) {
  return moduleSpecifierLiteral(node)?.text ?? null;
}

function canonicalSource(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const transformed = ts.transform(source, [
    (ctx) => (node) =>
      ts.visitNode(node, function visit(item) {
        const specifier = moduleSpecifier(item);
        if (specifier !== null) {
          const key = ts.factory.createStringLiteral(moduleKey(file, specifier));
          if (ts.isImportDeclaration(item))
            return ts.factory.updateImportDeclaration(
              item,
              item.modifiers,
              item.importClause,
              key,
              item.attributes,
            );
          if (ts.isExportDeclaration(item))
            return ts.factory.updateExportDeclaration(
              item,
              item.modifiers,
              item.isTypeOnly,
              item.exportClause,
              key,
              item.attributes,
            );
          return ts.factory.updateCallExpression(item, item.expression, item.typeArguments, [
            key,
            ...item.arguments.slice(1),
          ]);
        }
        return ts.visitEachChild(item, visit, ctx);
      }),
  ]);
  try {
    return ts.transpileModule(
      ts.createPrinter({ removeComments: true }).printFile(transformed.transformed[0]),
      {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      },
    ).outputText;
  } finally {
    transformed.dispose();
  }
}

function tokens(source) {
  const file = ts.createSourceFile("comparison.js", source, ts.ScriptTarget.Latest, true);
  const result = [];
  function visit(node) {
    if (ts.isStringLiteral(node)) {
      result.push(JSON.stringify(node.text));
      return;
    }
    const children = node.getChildren(file);
    if (children.length) children.forEach(visit);
    else if (node.kind !== ts.SyntaxKind.EndOfFileToken) result.push(node.getText(file));
  }
  // Parser tokens preserve regular-expression and template literal contents too.
  visit(file);
  return result.join(" ");
}

function compareForm(file, text) {
  const source = ts.createSourceFile(
    file,
    canonicalSource(file, text),
    ts.ScriptTarget.Latest,
    true,
  );
  const printer = ts.createPrinter({ removeComments: true });
  const imports = source.statements
    .filter(ts.isImportDeclaration)
    .map((statement) => tokens(printer.printNode(ts.EmitHint.Unspecified, statement, source)));
  const body = ts.factory.updateSourceFile(
    source,
    source.statements.filter((statement) => !ts.isImportDeclaration(statement)),
  );
  return { body: tokens(printer.printFile(body)), imports: imports.join("\n") };
}

function gitOriginal(ref) {
  try {
    const bytes = execFileSync("git", ["show", ref], {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const blob = execFileSync("git", ["rev-parse", "--verify", ref], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return { bytes, ref, blob };
  } catch {
    return null;
  }
}

function original(move) {
  const path = move.from;
  if (move.baselineCommit) return gitOriginal(`${move.baselineCommit}:${path}`);
  if (baselineReport) {
    const pinned = pinnedFiles.get(path);
    if (
      pinned?.to !== move.to ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(pinned.baselineBlob ?? "")
    )
      return null;
    try {
      // Uncommitted originals are embedded so Git GC cannot erase their baseline.
      const bytes =
        typeof pinned.originalBytesBase64 === "string"
          ? Buffer.from(pinned.originalBytesBase64, "base64")
          : execFileSync("git", ["cat-file", "blob", pinned.baselineBlob], {
              cwd: root,
              stdio: ["ignore", "pipe", "ignore"],
            });
      if (sha256(bytes) !== pinned.originalSha256) return null;
      const blob = createHash(pinned.baselineBlob.length === 40 ? "sha1" : "sha256")
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest("hex");
      if (blob !== pinned.baselineBlob) return null;
      return { bytes, ref: pinned.baselineRef, blob: pinned.baselineBlob };
    } catch {
      return null;
    }
  }
  for (const ref of baseline === "index" ? [":" + path, "HEAD:" + path] : [baseline + ":" + path]) {
    const previous = gitOriginal(ref);
    if (previous) return previous;
  }
  return null;
}

const report = {
  formatVersion: 2,
  baseline,
  gitHead,
  baselineGitHead,
  baselineApiFiles,
  byteIdenticalFiles: [],
  moduleSpecifierOnlyFiles: [],
  otherTextChanges: [],
  fileDetails: [],
  unchangedRuntimeBodies: [],
  changedRuntimeBodies: [],
  changedImports: [],
  importDetails: {},
  newHelpers: [],
  missingTargets: [],
  missingBaselines: [],
  unmappedApiDeletions: [],
  forbiddenEngineImports: [],
  additionalEngineFiles: [],
  duplicateSources: [],
  duplicateTargets: [],
  remainingOriginalFiles: [],
};
for (const [field, key] of [
  ["from", "duplicateSources"],
  ["to", "duplicateTargets"],
]) {
  const seen = new Set();
  for (const move of moves) {
    const path = resolve(root, move[field]);
    if (seen.has(path)) report[key].push(move[field]);
    seen.add(path);
  }
}
for (const move of moves) {
  const current = resolve(root, move.to);
  if (existsSync(resolve(root, move.from))) report.remainingOriginalFiles.push(move.from);
  if (!existsSync(current)) {
    report.missingTargets.push(move.to);
    continue;
  }
  const currentBytes = readFileSync(current);
  if (!move.hadBaseline) {
    report.newHelpers.push(move.to);
    report.fileDetails.push({
      from: move.from,
      to: move.to,
      comparison: "no-standalone-baseline",
      currentSha256: sha256(currentBytes),
    });
    continue;
  }
  const previous = original(move);
  if (previous === null) {
    report.missingBaselines.push(move.from);
    continue;
  }
  const before = compareForm(resolve(root, move.from), previous.bytes.toString("utf8"));
  const after = compareForm(current, currentBytes.toString("utf8"));
  const comparison = classifySourceText(
    resolve(root, move.from),
    previous.bytes,
    current,
    currentBytes,
  );
  report[
    {
      "byte-identical": "byteIdenticalFiles",
      "module-specifiers-only": "moduleSpecifierOnlyFiles",
      "other-text-changes": "otherTextChanges",
    }[comparison]
  ].push(move.to);
  const sourceFiles = additionalBaselines.get(move.baselineCommit) ?? committedApiFiles;
  const baselineOrigin =
    sourceFiles.get(move.from) === previous.blob
      ? "commit"
      : sourceFiles.has(move.from)
        ? "staged-modified"
        : "staged-only";
  report.fileDetails.push({
    from: move.from,
    to: move.to,
    baselineRef: previous.ref,
    baselineBlob: previous.blob,
    ...(move.baselineCommit ? { baselineCommit: move.baselineCommit } : {}),
    baselineOrigin,
    ...(baselineOrigin === "commit"
      ? {}
      : { originalBytesBase64: previous.bytes.toString("base64") }),
    originalSha256: sha256(previous.bytes),
    currentSha256: sha256(currentBytes),
    comparison,
    runtimeBodyUnchanged: before.body === after.body,
    importsUnchanged: before.imports === after.imports,
  });
  report[before.body === after.body ? "unchangedRuntimeBodies" : "changedRuntimeBodies"].push(
    move.to,
  );
  if (before.imports !== after.imports) {
    report.changedImports.push(move.to);
    report.importDetails[move.to] = {
      before: before.imports.split("\n"),
      after: after.imports.split("\n"),
    };
  }
}

// Compare the entire baseline API file inventory with the filesystem. This includes
// staged-only originals and does not let Git's rename detection conceal a deletion.
report.unmappedApiDeletions.push(
  ...baselineApiFiles
    .filter((path) => !existsSync(resolve(root, path)) && !forward.has(resolve(root, path)))
    .sort(),
);

function inspectEngine(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) {
      inspectEngine(file);
      continue;
    }
    if (!file.endsWith(".ts")) continue;
    if (!reverse.has(resolve(file))) report.additionalEngineFiles.push(relative(root, file));
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    function visit(node) {
      const specifier = moduleSpecifier(node);
      if (specifier !== null) {
        const target = resolveLocal(file, specifier);
        if (
          specifier === "hono" ||
          specifier.startsWith("hono/") ||
          specifier.startsWith("@repo/api") ||
          specifier.startsWith("@/") ||
          target?.startsWith(join(root, "apps") + "/")
        )
          report.forbiddenEngineImports.push({ file: relative(root, file), specifier });
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
}
inspectEngine(join(root, "packages/platform/src/engine"));
if (output) writeFileSync(resolve(output), JSON.stringify(report, null, 2) + "\n");
console.log(`SDK relocation audit against ${baseline} (${moves.length} mapped files)`);
for (const [key, value] of Object.entries(report))
  if (Array.isArray(value) && key !== "fileDetails" && key !== "baselineApiFiles")
    console.log(`${key}: ${value.length}`);
console.log(
  "Byte comparison retains all source bytes. Module-only comparison exempts only literal module strings; it does not prove target equivalence. Runtime-body comparison separately excludes static imports, comments, and types. Additional engine files are not covered by the relocation comparisons.",
);
if (
  report.missingTargets.length ||
  report.missingBaselines.length ||
  report.unmappedApiDeletions.length ||
  report.forbiddenEngineImports.length ||
  report.duplicateSources.length ||
  report.duplicateTargets.length
)
  process.exitCode = 1;
