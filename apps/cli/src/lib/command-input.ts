/** CLI syntax only. Resource validation and authorization belong to the SDK. */
import { readFileSync } from "node:fs";
import { InvalidArgumentError } from "commander";
import { CreateDeploymentSchema, parseInput } from "@repo/contracts";

export const collect = (value: string, previous: string[] = []): string[] => [...previous, value];

export function positiveInteger(value: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new InvalidArgumentError("Expected a positive integer.");
  return number;
}

export function timeoutMilliseconds(value: string): number {
  const number = positiveInteger(value);
  if (number > 2_147_483_647) throw new InvalidArgumentError("Timeout exceeds the supported timer range.");
  return number;
}

export function parsePairs(pairs: string[]): Record<string, string> {
  return Object.fromEntries(pairs.map(pair => {
    const separator = pair.indexOf("=");
    if (separator <= 0) throw new Error("Expected KEY=VALUE; values may be empty or contain '='.");
    return [pair.slice(0, separator), pair.slice(separator + 1)];
  }));
}

export function readJsonInput(file: string): unknown {
  return JSON.parse(readFileSync(file === "-" ? 0 : file, "utf8"));
}

/** Read secrets without putting them in process arguments or shell history. */
export function readSecret(file: string, options?: { preserveWhitespace?: boolean }): string {
  const input = readFileSync(file === "-" ? 0 : file, "utf8");
  const value = options?.preserveWhitespace ? input.replace(/\r?\n$/, "") : input.trim();
  if (!value) throw new Error("The secret input is empty.");
  return value;
}

export function parseDeploymentEnvironment(value: unknown) {
  try {
    return parseInput(CreateDeploymentSchema.properties.environment, value) ?? "production";
  } catch {
    throw new Error("Invalid --env / --environment. Expected a deployment variable set: production or preview.");
  }
}
