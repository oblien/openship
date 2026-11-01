import { describe, expect, it } from "vitest";
import { inspectCommandEnvironment, commandEnvironmentWarning } from "./command-environment";

describe("command environment migration", () => {
  it("extracts quoted literal assignments and preserves the remaining command", () => {
    expect(
      inspectCommandEnvironment(
        "  API='https://example.com/a?b=1' TITLE=\"two words\" bun run build && echo done",
      ),
    ).toEqual({
      variables: { API: "https://example.com/a?b=1", TITLE: "two words" },
      keys: ["API", "TITLE"],
      command: "bun run build && echo done",
      migratable: true,
    });
  });
  it.each([
    "env A=one python manage.py collectstatic",
    "cross-env A=one npm run build",
    "export A=one && go build",
  ])("supports %s", (command) => {
    expect(inspectCommandEnvironment(command)).toMatchObject({
      variables: { A: "one" },
      migratable: true,
    });
  });
  it.each([
    "A=$SECRET bun build",
    "A=$(id) bun build",
    "A=`id` bun build",
    'A="$SECRET" bun build',
    "A='unterminated",
    "A=x A=y bun build",
    "A=~/file bun build",
    "export A=x; bun build",
    "__proto__=literal bun build",
  ])("leaves dynamic or ambiguous syntax for manual review: %s", (command) => {
    expect(inspectCommandEnvironment(command).migratable).toBe(false);
  });
  it("keeps literal dollars and empty values", () => {
    expect(inspectCommandEnvironment("A='$SECRET' B= C=\\$literal bun build").variables).toEqual({
      A: "$SECRET",
      B: "",
      C: "$literal",
    });
  });
  it("never puts values in warnings", () => {
    expect(
      commandEnvironmentWarning("TOKEN=very-private npm run build", "Build command"),
    ).not.toContain("very-private");
    expect(inspectCommandEnvironment("bun run build").migratable).toBe(false);
  });
  it.each([
    "prepare && TOKEN=secret npm run build",
    "prepare; env TOKEN=secret node server.js",
    "prepare\nexport TOKEN=secret && node server.js",
    "prepare | TOKEN=secret node server.js",
    "(TOKEN=secret node server.js)",
    "TOKEN=first prepare && TOKEN=second node server.js",
  ])("warns about chained assignments without attempting a partial migration: %s", (command) => {
    expect(inspectCommandEnvironment(command)).toMatchObject({
      keys: ["TOKEN"],
      migratable: false,
    });
    expect(commandEnvironmentWarning(command, "Build")).not.toContain("secret");
  });
  it("does not interpret quoted or escaped separators as later commands", () => {
    for (const command of [
      "printf '&& TOKEN=literal'",
      'printf "; TOKEN=literal"',
      "printf \\; TOKEN=argument",
    ])
      expect(inspectCommandEnvironment(command).keys).toEqual([]);
    expect(inspectCommandEnvironment("\n TOKEN=literal build").migratable).toBe(true);
  });
});
