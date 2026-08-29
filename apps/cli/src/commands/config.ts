/**
 * `openship config init` / `openship config validate` — author and check the
 * repo-root `openship.json` (Openship's declarative deploy config).
 *
 * `validate` runs the SAME validator the deploy pipeline uses
 * (`parseOpenshipConfigJson` from @repo/core, over the same `parseOpenshipConfig`
 * the API calls), so a file that validates here behaves identically on deploy —
 * and since #641 the deploy REPORTS the same refusals instead of applying what it
 * can and staying quiet. This command keeps the engine's exact JSON syntax-error
 * text, which the API deliberately does NOT forward: it quotes the offending
 * bytes back, and only here is that the user's own file on their own machine.
 * `init` scaffolds a minimal, valid starter with
 * the `$schema` line (editor autocomplete) plus whatever we can cheaply detect
 * locally (package manager from the lockfile, a build script from package.json).
 */
import { Command } from "commander";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseOpenshipConfigJson, type OpenshipConfig } from "@repo/core";
import { err, info, isJsonMode, ok, printJson } from "../lib/output";

const SCHEMA_URL = "https://openship.io/openship.schema.json";
const CONFIG_FILE = "openship.json";

/** Cheap, dependency-free stack hints from the target dir. No network, no clone. */
function detectHints(dir: string): Partial<OpenshipConfig> {
  const hints: Partial<OpenshipConfig> = {};
  const lock: Array<[string, OpenshipConfig["packageManager"]]> = [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lockb", "bun"],
    ["package-lock.json", "npm"],
  ];
  for (const [file, pm] of lock) {
    if (existsSync(join(dir, file))) {
      hints.packageManager = pm;
      break;
    }
  }
  const pkgPath = join(dir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
      const runner = hints.packageManager ?? "npm";
      const exec = runner === "npm" ? "npm run" : runner;
      if (pkg.scripts?.build) hints.buildCommand = `${exec} build`;
      if (pkg.scripts?.start) hints.startCommand = `${exec} start`;
    } catch {
      /* unreadable package.json — skip script hints */
    }
  }
  return hints;
}

const initCmd = new Command("init")
  .description("Scaffold an openship.json in the current directory")
  .option("--dir <path>", "Directory to write into", process.cwd())
  .option("--force", "Overwrite an existing openship.json")
  .action((opts) => {
    const dir: string = opts.dir || process.cwd();
    const path = join(dir, CONFIG_FILE);
    if (existsSync(path) && !opts.force) {
      err(`${CONFIG_FILE} already exists. Re-run with --force to overwrite.`);
      process.exit(1);
    }

    const hints = detectHints(dir);
    // $schema first (editor autocomplete); then detected fields. Everything else
    // is intentionally omitted — Openship auto-detects it, and openship.json only
    // needs to carry what you want to override.
    const scaffold: Record<string, unknown> = { $schema: SCHEMA_URL, ...hints };
    const text = JSON.stringify(scaffold, null, 2) + "\n";
    writeFileSync(path, text);

    if (isJsonMode()) {
      printJson({ path, config: scaffold });
      return;
    }
    ok(`\n  Wrote ${CONFIG_FILE} → ${path}`);
    info("  Edit it to declare framework, env, domains, resources, services… then `openship config validate`.\n");
  });

const validateCmd = new Command("validate")
  .description("Validate an openship.json against the deploy schema")
  .argument("[file]", "Path to the config file", CONFIG_FILE)
  .action((file: string) => {
    const path = file === CONFIG_FILE ? join(process.cwd(), CONFIG_FILE) : file;
    if (!existsSync(path)) {
      if (isJsonMode()) printJson({ valid: false, errors: [`${path} not found`], warnings: [] });
      else err(`Not found: ${path}`);
      process.exit(1);
    }

    const { config, errors, warnings } = parseOpenshipConfigJson(readFileSync(path, "utf8"));
    const valid = errors.length === 0 && config !== null;

    if (isJsonMode()) {
      printJson({ valid, errors, warnings });
      process.exit(valid ? 0 : 1);
    }

    for (const w of warnings) info(`  ⚠ ${w}`);
    if (!valid) {
      err(`\n  ${errors.length} error${errors.length === 1 ? "" : "s"} in ${CONFIG_FILE}:`);
      for (const e of errors) err(`    • ${e}`);
      process.exit(1);
    }
    ok(`\n  ${CONFIG_FILE} is valid${warnings.length ? ` (${warnings.length} warning${warnings.length === 1 ? "" : "s"})` : ""}.\n`);
  });

export const configCommand = new Command("config")
  .description("Author and validate openship.json (declarative deploy config)")
  .addCommand(initCmd)
  .addCommand(validateCmd);
