import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseEnvFile, serializeEnvFile } from "./env-file";

const values = [
  ["empty", ""],
  ["simple", "3000"],
  ["equals", "a=b=c=="],
  ["spaces", "  keep these  "],
  ["tabs", "\tkeep\tthese\t"],
  ["hash", "a#b # c"],
  ["both quotes", `both 'single' and "double" quotes`],
  ["all quotes", "  'single' and \"double\" and `backticks` # text  "],
  ["leading quotes", `'single' then "double"`],
  ["dollar", "${OPENSHIP_TEST_REFERENCE}"],
  ["dollar with apostrophe", "user's${OPENSHIP_TEST_REFERENCE}token"],
  ["bare variable", "user's$OPENSHIP_TEST_REFERENCE"],
  ["double dollar", "user's$$OPENSHIP_TEST_REFERENCE"],
  ["literal dollar", "user's$"],
  ["dollar operators", "'${OPENSHIP_TEST_REFERENCE:-fallback}' ${MISSING?required}"],
  ["multiline", "first\nNEXT=part of this value\nlast"],
  ["multiline with quotes", "first 'line'\nNEXT=\"still this value\"\nlast\n"],
  ["CRLF", "first\r\nlast\r\n"],
  ["carriage return", "first\rlast"],
  ["control escapes", "'\x07\b\f\t\v'"],
  ["windows path", "C:\\new\\folder\\"],
  ["quoted trailing backslash", " spaces # and a slash\\"],
  ["even trailing backslashes", " spaces # and two slashes\\\\"],
  ["literal escape", "user's literal \\n and a real\nnewline"],
  ["escaped dollar", "user's\\${OPENSHIP_TEST_REFERENCE}"],
  ["escaped quote", "  backslash \\\" and \\' text #  "],
  ["Unicode", "مرحبا 🌍 café 中文"],
  ["Unicode whitespace", "\u00a0keep\u2028this\u00a0"],
] as const;

const literalEntries = (content: string) =>
  parseEnvFile(content).map(({ key, value }) => ({ key, value }));
const parts = [
  "",
  "a",
  "'",
  '"',
  "`",
  "\\",
  "\\\\",
  "$",
  "${REF}",
  "#",
  " ",
  "\n",
  "\r\n",
  "\t",
  "🛳",
];
const combinations = parts.flatMap((first) =>
  parts.flatMap((second) => parts.map((last) => first + second + last)),
);

describe("literal environment files", () => {
  it.each(values)("preserves %s with a following assignment", (_name, value) => {
    const rows = [
      { key: "VALUE", value },
      { key: "AFTER", value: "untouched" },
    ];
    expect(literalEntries(serializeEnvFile(rows))).toEqual(rows);
  });

  it("keeps quoting and backslash combinations intact across many entries", () => {
    const rows = combinations.map((value, i) => ({ key: `VALUE_${i}`, value }));
    expect(literalEntries(serializeEnvFile(rows))).toEqual(rows);
  });

  it("separates literal values from Compose interpolation, including escaped dollars", () => {
    expect(
      parseEnvFile(String.raw`A="\$REF $REF \${REF} $$ \\\$REF"
B='$REF'
C=$REF`),
    ).toEqual([
      {
        key: "A",
        value: "$REF $REF ${REF} $$ \\$REF",
        interpolation: "$$REF $REF $${REF} $$ \\$$REF",
      },
      { key: "B", value: "$REF" },
      { key: "C", value: "$REF", interpolation: "$REF" },
    ]);
  });

  it("accepts escaped apostrophes and closes quotes after even backslashes", () => {
    expect(
      literalEntries(String.raw`A='it\'s literal'
B="trailing\\"
C='trailing\\'
AFTER=ok`),
    ).toEqual([
      { key: "A", value: "it's literal" },
      { key: "B", value: "trailing\\" },
      { key: "C", value: "trailing\\\\" },
      { key: "AFTER", value: "ok" },
    ]);
  });

  it("rejects invalid or duplicate names before producing a file", () => {
    for (const key of ["", "1BAD", "BAD-KEY", "BAD\nINJECTED", "BAD=KEY", "export BAD"]) {
      expect(() =>
        serializeEnvFile([
          { key: "VALID", value: "first" },
          { key, value: "secret" },
        ]),
      ).toThrow();
    }
    expect(() =>
      serializeEnvFile([
        { key: "KEY", value: "first" },
        { key: " KEY ", value: "second" },
      ]),
    ).toThrow();
    expect(serializeEnvFile([])).toBe("");
  });

  it("does not export null bytes that would truncate a process environment value", () => {
    expect(() => serializeEnvFile([{ key: "SECRET", value: "before\0after" }])).toThrow(
      "null bytes",
    );
  });

  it("keeps ordinary quoted passwords, dollars and trailing paths readable by Node", () => {
    const rows = [
      { key: "QUOTES", value: `both 'single' and "double" quotes` },
      { key: "DOLLAR", value: "${OPENSHIP_TEST_REFERENCE}" },
      { key: "PATH_VALUE", value: "C:\\new\\folder\\" },
      { key: "MULTILINE", value: "first\nNEXT=not an assignment\nlast" },
    ];
    expect(parseEnv(serializeEnvFile(rows))).toEqual(
      Object.fromEntries(rows.map(({ key, value }) => [key, value])),
    );
  });
});

// This uses Compose's real dotenv reader without a Docker daemon or containers.
// Unit tests and the engine integration tests still run when its CLI is absent.
const hasCompose =
  spawnSync("docker", ["compose", "version"], { stdio: "ignore", timeout: 10_000 }).status === 0;
describe.skipIf(!hasCompose)("environment export through Docker Compose", () => {
  let directory: string;
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "openship-env-file-"));
    writeFileSync(join(directory, "compose.yml"), "services:\n  probe:\n    image: busybox\n");
  });
  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it.each(values)("loads %s as the original literal value", (_name, value) => {
    const key = "ZZ_OPENSHIP_DOTENV";
    writeFileSync(join(directory, "download.env"), serializeEnvFile([{ key, value }]), {
      mode: 0o600,
    });
    const result = spawnSync(
      "docker",
      [
        "compose",
        "--project-name",
        "openship-env-test",
        "--env-file",
        "download.env",
        "-f",
        "compose.yml",
        "config",
        "--environment",
      ],
      {
        cwd: directory,
        env: { PATH: process.env.PATH, OPENSHIP_TEST_REFERENCE: "must-not-replace-the-secret" },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    expect(result.status, result.stderr).toBe(0);
    // --environment prints unescaped values, sorted by key. Our isolated key
    // sorts last, so even embedded newlines and assignment-looking text are exact.
    const prefix = `${key}=`;
    const line = result.stdout.indexOf(`\n${prefix}`);
    expect(line).toBeGreaterThanOrEqual(0);
    expect(result.stdout.slice(line + 1)).toBe(`${prefix}${value}\n`);
  });

  it("preserves all 3,375 quoting combinations in a real loader, without extra assignments", () => {
    const rows = combinations.map((value, i) => ({
      key: `ZZ_OPENSHIP_${String(i).padStart(4, "0")}`,
      value,
    }));
    writeFileSync(join(directory, "download.env"), serializeEnvFile(rows), { mode: 0o600 });
    const result = spawnSync(
      "docker",
      [
        "compose",
        "--project-name",
        "openship-env-test",
        "--env-file",
        "download.env",
        "-f",
        "compose.yml",
        "config",
        "--environment",
      ],
      {
        cwd: directory,
        env: { PATH: process.env.PATH, REF: "must-stay-literal" },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    expect(result.status, result.stderr).toBe(0);
    const line = result.stdout.indexOf("\nZZ_OPENSHIP_0000=");
    expect(line).toBeGreaterThanOrEqual(0);
    expect(result.stdout.slice(line + 1)).toBe(
      rows.map(({ key, value }) => `${key}=${value}\n`).join(""),
    );
  });
});
