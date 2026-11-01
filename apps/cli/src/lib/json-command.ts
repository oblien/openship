import type { Command } from "commander";
import type { Static, TSchema } from "@sinclair/typebox";
import { parseInput } from "@repo/contracts";
import { readJsonInput } from "./command-input";
import { confirmOrExit, printResult } from "./cmd-helpers";

interface JsonOptions {
  schema?: boolean;
  yes?: boolean;
}
async function runJson<S extends TSchema>(
  schema: S,
  file: string | undefined,
  opts: JsonOptions,
  run: (input: Static<S>) => Promise<unknown>,
  confirmation?: string,
): Promise<unknown> {
  if (opts.schema) {
    if (file) throw new Error("Choose an input file or --schema.");
    return schema;
  }
  if (!file) throw new Error("Supply a JSON file, - for stdin, or --schema to inspect the input.");
  const input = parseInput(schema, readJsonInput(file));
  if (confirmation) await confirmOrExit(opts.yes, confirmation);
  return run(input);
}

function addInput(command: Command, confirmation?: string): Command {
  command
    .argument("[file]", "JSON input file, or - for stdin")
    .option("--schema", "Print the accepted JSON schema without making a request");
  if (confirmation) command.option("-y, --yes", "Confirm this operation");
  return command;
}

/** Complex configurations use the SDK's schema, including discovery and validation. */
export function jsonCommand<S extends TSchema>(
  command: Command,
  schema: S,
  run: (input: Static<S>) => Promise<unknown>,
  confirmation?: string,
): Command {
  return addInput(command, confirmation).action((file: string | undefined, opts) =>
    printResult(() => runJson(schema, file, opts, run, confirmation)),
  );
}

export function jsonResourceCommand<S extends TSchema>(
  command: Command,
  schema: S,
  run: (id: string, input: Static<S>) => Promise<unknown>,
  confirmation?: string,
): Command {
  command.argument("<id>", "Resource ID");
  return addInput(command, confirmation).action((id: string, file: string | undefined, opts) =>
    printResult(() =>
      runJson(
        schema,
        file,
        opts,
        (input) => run(id, input),
        confirmation ? `${confirmation} (${id})` : undefined,
      ),
    ),
  );
}

export function jsonChildResourceCommand<S extends TSchema>(
  command: Command,
  schema: S,
  run: (parent: string, id: string, input: Static<S>) => Promise<unknown>,
  confirmation?: string,
): Command {
  command.argument("<parent>", "Parent resource ID").argument("<id>", "Resource ID or name");
  return addInput(command, confirmation).action(
    (parent: string, id: string, file: string | undefined, opts) =>
      printResult(() =>
        runJson(
          schema,
          file,
          opts,
          (input) => run(parent, id, input),
          confirmation ? `${confirmation} (${parent}/${id})` : undefined,
        ),
      ),
  );
}
