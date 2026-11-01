import * as outputFs from "node:fs/promises";
import * as outputPath from "node:path";
import { createHash } from "node:crypto";
import { shellQuote, STACKS, type StackDefinition } from "@repo/core";
import type { BuildConfig } from "../types";

export interface NodeOutputOptions {
  kind: "nextjs" | "node";
  directory: string;
  entry: string;
  projectDir: string;
  rootDirectory?: string;
  startCommand?: string;
  defaultStartCommand?: string;
  writeLauncher?: boolean;
  runtime?: "node" | "bun";
}

// Embedded JavaScript is deliberate: serializing Function.toString() breaks
// when release/test bundlers rewrite imports or inject module-scoped helpers.
// Both local and remote execution use these exact bytes.
export const NODE_OUTPUT_PREPARER = String.raw`async function prepareNodeOutput(options, fs, path) {
  const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
  const exists = async (file) => {
    try { return (await fs.stat(file)).isFile(); }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
  };
  const confined = (base, relative) => {
    const resolved = path.resolve(base, relative);
    if (resolved !== path.resolve(base) && !resolved.startsWith(path.resolve(base) + path.sep)) throw new Error("Build output path escapes its bundle");
    return resolved;
  };
  const projectDir = path.resolve(options.projectDir);
  const output = confined(projectDir, options.directory);
  const bundleDir = options.kind === "nextjs" ? path.join(output, "standalone") : output;
  let entry = options.entry;
  if (options.kind === "nextjs") {
    const manifest = path.join(output, "required-server-files.json");
    let appPath = options.rootDirectory ?? "";
    if (await exists(manifest)) {
      const metadata = JSON.parse(await fs.readFile(manifest, "utf8"));
      if (typeof metadata.relativeAppDir === "string") appPath = metadata.relativeAppDir;
    }
    const nested = path.join(appPath, "server.js");
    // Use Next's manifest (or the selected app path), never the first server.js
    // found in a bundle that can contain several applications and dependencies.
    if (await exists(confined(bundleDir, nested))) entry = nested;
    else entry = "server.js";
  }
  let plan = null;
  const server = confined(bundleDir, entry);
  let auto = !options.startCommand || options.startCommand === options.defaultStartCommand;
  if (/^(?:npm|pnpm|yarn|bun)(?: run)? start$/.test(options.startCommand ?? "")) {
    const packageFile = path.join(projectDir, "package.json");
    if (await exists(packageFile)) {
      const pkg = JSON.parse(await fs.readFile(packageFile, "utf8"));
      auto = pkg.scripts?.start === options.defaultStartCommand;
    }
  }
  if (await exists(server)) {
    if (options.kind === "nextjs") {
      const appDir = path.dirname(server);
      for (const [source, target] of [[path.join(output, "static"), confined(appDir, path.join(options.directory, "static"))], [path.join(projectDir, "public"), path.join(appDir, "public")]]) {
        try { await fs.cp(source, target, { recursive: true }); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
    }
    if (!auto && options.kind === "nextjs") {
      const explicit = options.startCommand?.match(/^node\s+([.\w/-]+server\.js)$/);
      if (explicit && !(await exists(confined(projectDir, explicit[1]))))
        throw new Error("The configured standalone start command points to a missing server. Clear the override to use automatic output detection.");
    }
    if (auto) plan = { bundleDir, startCommand: (options.runtime || "node") + " " + quote(entry) };
  }
  if (options.writeLauncher) {
    const command = plan
      ? "cd " + quote(path.relative(projectDir, bundleDir) || ".") + "\nexec " + plan.startCommand
      : "exec sh -c " + quote(options.startCommand || options.defaultStartCommand || "npm start");
    await fs.writeFile(path.join(projectDir, ".openship-start.sh"), "#!/bin/sh\nset -e\n" + command + "\n", { mode: 0o755 });
    console.log(plan ? "Prepared self-contained application output and automatic start command." : "Using the configured application start command.");
  }
  return plan;
}
`;
const prepare = new Function("return (" + NODE_OUTPUT_PREPARER + ")")() as (
  options: NodeOutputOptions,
  fs: typeof outputFs,
  path: typeof outputPath,
) => Promise<{ bundleDir: string; startCommand: string } | null>;
export const prepareNodeOutput = (options: NodeOutputOptions) =>
  prepare(options, outputFs, outputPath);

export function nodeOutputOptions(
  config: Pick<BuildConfig, "stack"> &
    Partial<
      Pick<
        BuildConfig,
        "rootDirectory" | "startCommand" | "isStatic" | "outputDirectory" | "packageManager"
      >
    >,
  projectDir: string,
): NodeOutputOptions | undefined {
  const stack = (STACKS as Record<string, StackDefinition>)[config.stack];
  const output = stack?.serverOutput;
  if (!output || config.isStatic) return;
  return {
    ...output,
    directory: config.outputDirectory || output.directory,
    projectDir,
    runtime: config.packageManager === "bun" ? "bun" : "node",
    rootDirectory: config.rootDirectory,
    startCommand: config.startCommand,
    defaultStartCommand: stack.defaultStartCommand,
  };
}

export function prepareNodeOutputCommand(
  config: Parameters<typeof nodeOutputOptions>[0],
  projectDir = ".",
): string | undefined {
  const options = nodeOutputOptions(config, projectDir);
  if (!options) return;
  const script = `Promise.all([import("node:fs/promises"), import("node:path")]).then(([fs, path]) => (${NODE_OUTPUT_PREPARER})(${JSON.stringify({ ...options, writeLauncher: true })}, fs, path)).catch(error => { console.error(error.message); process.exit(1); });`;
  // A one-line transport preserves comments/newlines through Dockerfile parsing.
  return `openship_output_runtime=$(command -v node || command -v bun) && "$openship_output_runtime" -e ${shellQuote(`eval(Buffer.from(${JSON.stringify(Buffer.from(script).toString("base64"))}, "base64").toString())`)}`;
}

export const AUTOMATIC_START = "exec sh .openship-start.sh";
export const START_SOURCE_LABEL = "io.openship.start-source";
export const START_COMMAND_LABEL = "io.openship.start-command";
export const startCommandDigest = (command: string | undefined) =>
  createHash("sha256")
    .update(command ?? "")
    .digest("hex");
export function imageStartCommand(
  labels: Record<string, string> | undefined,
  command: string | undefined,
): string | undefined {
  return labels?.[START_SOURCE_LABEL] === startCommandDigest(command) &&
    (labels[START_COMMAND_LABEL] === AUTOMATIC_START ||
      labels[START_COMMAND_LABEL] === "sh .openship-start.sh")
    ? AUTOMATIC_START
    : command;
}
