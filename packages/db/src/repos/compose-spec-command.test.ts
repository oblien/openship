import { describe, expect, it } from "vitest";
import {
  composeSpecDiff,
  composeSpecsEqual,
  composeWritePatch,
  toComposeSpec,
} from "./service.repo";

/**
 * #332 drift stability: adding structured `commandArgv` must NOT make a legacy
 * row (stored with only the text `command`, argv null) read as drift against its
 * re-parse (same command, argv populated). `toComposeSpec` derives argv from the
 * text command so both canonicalize identically. A genuine argv change still
 * surfaces.
 */
describe("compose command drift stability (#332)", () => {
  it("legacy text command ≡ re-parsed command+argv (no phantom drift)", () => {
    const legacy = toComposeSpec({ command: "serve --host 0.0.0.0" }); // argv null → derived
    const reparsed = toComposeSpec({
      command: "serve --host 0.0.0.0",
      commandArgv: ["serve", "--host", "0.0.0.0"],
    });
    expect(composeSpecsEqual(legacy, reparsed)).toBe(true);
    expect(
      composeSpecDiff(legacy, reparsed).some(
        (c) => c.field === "command" || c.field === "commandArgv",
      ),
    ).toBe(false);
  });

  it("a genuine argv change is still flagged", () => {
    const before = toComposeSpec({
      command: "serve --host 0.0.0.0",
      commandArgv: ["serve", "--host", "0.0.0.0"],
    });
    const after = toComposeSpec({
      command: "serve --host ::",
      commandArgv: ["serve", "--host", "::"],
    });
    expect(composeSpecsEqual(before, after)).toBe(false);
    expect(
      composeSpecDiff(before, after).some(
        (c) => c.field === "command" || c.field === "commandArgv",
      ),
    ).toBe(true);
  });

  it("args-with-spaces: a real representation difference the old join lost is caught", () => {
    // old join stored "a b" (argv null → derived ["a","b"]); a genuine list ["a b"]
    const derivedFromLegacy = toComposeSpec({ command: "a b" });
    const genuineSingleArg = toComposeSpec({ command: "a b", commandArgv: ["a b"] });
    expect(composeSpecsEqual(derivedFromLegacy, genuineSingleArg)).toBe(false);
  });

  it("null command ≡ null command", () => {
    expect(composeSpecsEqual(toComposeSpec({}), toComposeSpec({}))).toBe(true);
  });
});

describe("compose build args drift stability (#689)", () => {
  it("round-trips null/empty values and ignores map key order", () => {
    const first = toComposeSpec({
      buildArgs: { APP_PACKAGE: "@myorg/api", FROM_ENV: null, EMPTY: "" },
    });
    const reordered = toComposeSpec({
      buildArgs: { EMPTY: "", FROM_ENV: null, APP_PACKAGE: "@myorg/api" },
    });
    expect(first.buildArgs).toEqual({
      APP_PACKAGE: "@myorg/api",
      FROM_ENV: null,
      EMPTY: "",
    });
    expect(composeSpecsEqual(first, reordered)).toBe(true);
  });

  it("reports changed and removed service build args", () => {
    const before = toComposeSpec({ buildArgs: { APP_PACKAGE: "@myorg/api", OLD: "1" } });
    const after = toComposeSpec({ buildArgs: { APP_PACKAGE: "@myorg/worker" } });
    expect(composeSpecsEqual(before, after)).toBe(false);
    expect(composeSpecDiff(before, after)).toContainEqual({
      field: "buildArgs",
      from: { APP_PACKAGE: "@myorg/api", OLD: "1" },
      to: { APP_PACKAGE: "@myorg/worker" },
    });
  });

  it("preserves args when an old non-authoritative snapshot omits the field", () => {
    const patch = composeWritePatch(
      { name: "api", image: "example/api:1" },
      { buildArgs: { APP_PACKAGE: "@myorg/api" } },
    );
    expect(patch.buildArgs).toEqual({ APP_PACKAGE: "@myorg/api" });
  });

  it("clears args when a fresh authoritative compose parse removes them", () => {
    const patch = composeWritePatch(
      { name: "api", image: "example/api:1" },
      { buildArgs: { APP_PACKAGE: "@myorg/api" } },
      true,
    );
    expect(patch.buildArgs).toEqual({});
  });

  it("marks normalized/manual args literal instead of inheriting stale template provenance", () => {
    const patch = composeWritePatch(
      { name: "api", buildArgs: { HOME_REF: "$HOME" } },
      { advanced: { buildArgTemplateKeys: ["HOME_REF"] } },
    );
    expect(patch.advanced.buildArgTemplateKeys).toEqual([]);

    const raw = composeWritePatch({
      name: "api",
      buildArgs: { HOME_REF: "$$HOME" },
      advanced: { buildArgTemplateKeys: ["HOME_REF"] },
    });
    expect(raw.advanced.buildArgTemplateKeys).toEqual(["HOME_REF"]);
  });

  it("clears stale provenance without adding metadata for an explicit empty arg map", () => {
    const patch = composeWritePatch(
      { name: "api", buildArgs: {} },
      {
        advanced: {
          readiness: { enabled: true },
          buildArgTemplateKeys: ["OLD_ARG"],
        },
      },
    );

    expect(patch.advanced).toEqual({ readiness: { enabled: true } });
  });

  it("uses an empty parser provenance marker to clear stale args in non-authoritative syncs", () => {
    const patch = composeWritePatch(
      { name: "api", advanced: { buildArgTemplateKeys: [] } },
      {
        buildArgs: { OLD_ARG: "stale" },
        advanced: { buildArgTemplateKeys: ["OLD_ARG"] },
      },
    );

    expect(patch.buildArgs).toEqual({});
    expect(patch.advanced.buildArgTemplateKeys).toEqual([]);
  });
});

/**
 * `composeWritePatch` is the ONE gate every compose-sync writer passes through —
 * the sync endpoint, the migration importer, and (the one that bit) the deploy
 * request's own service list, whose wire shape carried `command` as a string only.
 * Because the stored string is a lossy display join, letting toComposeSpec re-derive
 * argv there meant a client replaying its service list re-split a correct
 * `["sh","-c","a && b"]` into five words on the next deploy.
 */
describe("composeWritePatch keeps argv faithful across a string-only writer (#332)", () => {
  const storedListCommand = {
    command: "sh -c a && b", // the lossy display join of the argv below
    commandArgv: ["sh", "-c", "a && b"],
  };

  it("an unchanged command string leaves the stored argv alone", () => {
    const patch = composeWritePatch({ name: "web", command: "sh -c a && b" }, storedListCommand);
    expect(patch.commandArgv).toEqual(["sh", "-c", "a && b"]);
  });

  it("without that rule the same input would have re-split the join", () => {
    // No stored row (a brand-new service): deriving is correct here.
    const patch = composeWritePatch({ name: "web", command: "sh -c a && b" }, null);
    expect(patch.commandArgv).toEqual(["sh", "-c", "a", "&&", "b"]);
  });

  it("a genuinely changed command re-derives argv", () => {
    const patch = composeWritePatch(
      { name: "web", command: "server start --verbose" },
      { command: "server start", commandArgv: ["server", "start"] },
    );
    expect(patch.commandArgv).toEqual(["server", "start", "--verbose"]);
  });

  it("an explicit argv from the parser wins over both", () => {
    const patch = composeWritePatch(
      { name: "web", command: "sh -c a && b", commandArgv: ["sh", "-c", "a && b"] },
      { command: "server start", commandArgv: ["server", "start"] },
    );
    expect(patch.commandArgv).toEqual(["sh", "-c", "a && b"]);
  });

  it("a dropped command clears argv with it", () => {
    const patch = composeWritePatch({ name: "web" }, storedListCommand);
    expect(patch.command).toBeNull();
    expect(patch.commandArgv).toBeNull();
  });

  it("still backfills a legacy row that has a command but no argv", () => {
    const patch = composeWritePatch(
      { name: "web", command: "server start" },
      { command: "server start", commandArgv: null },
    );
    expect(patch.commandArgv).toEqual(["server", "start"]);
  });
});

/**
 * #575: `entrypoint` is COMPOSE-OWNED, so removing `entrypoint:` from the file has to
 * hand the image's own ENTRYPOINT back — the same reasoning as `networkMode`/`pidMode`,
 * and the opposite of the merge that protects keys compose cannot express (a readiness
 * gate, generated files, an alias).
 *
 * The trap this pins is that the owned-key sweep tests for `undefined`, not falsiness:
 * `entrypoint: []` IS a value — compose's "clear the image ENTRYPOINT" — so a truthiness
 * test would quietly reinstate the wrapper the operator asked to remove.
 */
describe("composeWritePatch — entrypoint is compose-owned (#575)", () => {
  const storedOverride = { advanced: { entrypoint: ["/old-init.sh"] } };
  /** `composeAuthoritative` = the input IS a fresh read of the file. */
  const fromFile = true;

  it("applies an entrypoint the file declares", () => {
    const patch = composeWritePatch(
      { name: "web", advanced: { entrypoint: ["/new-init.sh", "-v"] } },
      storedOverride,
      fromFile,
    );
    expect(patch.advanced?.entrypoint).toEqual(["/new-init.sh", "-v"]);
  });

  it("KEEPS an empty array — the clear survives the owned-key sweep", () => {
    const patch = composeWritePatch(
      { name: "web", advanced: { entrypoint: [] } },
      storedOverride,
      fromFile,
    );
    expect(patch.advanced?.entrypoint).toEqual([]);
  });

  it("drops the override when the file no longer declares one", () => {
    const patch = composeWritePatch({ name: "web", advanced: {} }, storedOverride, fromFile);
    expect(patch.advanced?.entrypoint).toBeUndefined();
  });

  // The half that must NOT delete: several syncFromCompose callers pass a release's
  // frozen snapshot rather than a fresh parse, and that shape carries no `advanced` at
  // all — so its silence cannot be read as "the operator removed the entrypoint".
  it("leaves it alone when the writer is not speaking for the file", () => {
    const patch = composeWritePatch({ name: "web", advanced: {} }, storedOverride);
    expect(patch.advanced?.entrypoint).toEqual(["/old-init.sh"]);
  });

  it("does not disturb sibling advanced keys compose cannot express", () => {
    const patch = composeWritePatch(
      { name: "web", advanced: { entrypoint: [] } },
      { advanced: { entrypoint: ["/old-init.sh"], readiness: { enabled: true } } },
      fromFile,
    );
    expect(patch.advanced?.entrypoint).toEqual([]);
    expect(patch.advanced?.readiness).toEqual({ enabled: true });
  });
});

describe("compose environment templates (#673)", () => {
  it("persists the raw expression instead of its scan-time partial value", () => {
    const spec = toComposeSpec({
      environment: { DATABASE_URL: "postgresql://user:@db/app" },
      environmentTemplates: {
        DATABASE_URL: "postgresql://user:${POSTGRES_PASSWORD:?set it}@db/app",
      },
      advanced: { environmentTemplateKeys: ["DATABASE_URL"] },
    });

    expect(spec.environment?.DATABASE_URL).toBe(
      "postgresql://user:${POSTGRES_PASSWORD:?set it}@db/app",
    );
    expect(spec.advanced?.environmentTemplateKeys).toEqual(["DATABASE_URL"]);
  });

  it("clears template provenance when an authoritative re-parse removes it", () => {
    const patch = composeWritePatch(
      { name: "api", environment: { DATABASE_URL: "literal" }, advanced: {} },
      { advanced: { environmentTemplateKeys: ["DATABASE_URL"] } },
      true,
    );

    expect(patch.advanced.environmentTemplateKeys).toBeUndefined();
  });

  it("preserves template provenance through a non-authoritative snapshot sync", () => {
    const patch = composeWritePatch(
      { name: "api", environment: { DATABASE_URL: "••••••••" } },
      { advanced: { environmentTemplateKeys: ["DATABASE_URL"] } },
    );

    expect(patch.advanced.environmentTemplateKeys).toEqual(["DATABASE_URL"]);
  });
});
