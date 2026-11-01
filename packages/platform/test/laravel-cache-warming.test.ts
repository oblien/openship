import { describe, expect, it } from "vitest";

import { STACKS } from "@repo/core";

import { detectStack, type RepoFile } from "../src/engine/lib/stack-detector";

/**
 * Integration coverage for issue #19 — opt-in Laravel web-role cache warming.
 *
 * These tests drive the REAL resolution path: `detectStack` reads the repo
 * files, parses `openship.json` into deployment metadata, folds it over the
 * detected stack, and finalizes the web command. They would FAIL if the
 * `optimize` flag were parsed but never wired into that path (the gap Rex
 * caught), because they assert on `detectStack`'s output, not on
 * `resolveWebCommand` in isolation.
 */

const WARMUP_PREFIX = "php artisan optimize && ";

const LARAVEL_FILES: RepoFile[] = [
  { name: "composer.json", type: "file" },
  { name: "artisan", type: "file" },
  { name: "openship.json", type: "file" },
];

const COMPOSER_JSON = JSON.stringify({ require: { "laravel/framework": "^11.0" } });

function detectLaravelWith(openshipConfig: Record<string, unknown>) {
  return detectStack(LARAVEL_FILES, undefined, {
    "composer.json": COMPOSER_JSON,
    "openship.json": JSON.stringify(openshipConfig),
  });
}

describe("Laravel opt-in cache warming (#19) — real detectStack path", () => {
  it("prepends the warmup to the FINAL web command when optimize is true", () => {
    const warmed = detectLaravelWith({ framework: "laravel", optimize: true });

    // The bare preset, resolved WITHOUT the flag, is the byte-identical baseline.
    const bare = detectLaravelWith({ framework: "laravel" }).startCommand;

    expect(warmed.stack).toBe("laravel");
    expect(warmed.startCommand).toBe(`${WARMUP_PREFIX}${bare}`);
    // The exec/PID-1 frankenphp invocation still terminates the command, so the
    // server process receives SIGTERM — warming only prepends, never replaces.
    expect(warmed.startCommand.endsWith("exec frankenphp run --config /etc/frankenphp/Caddyfile --adapter caddyfile")).toBe(true);
  });

  it("leaves the bare preset byte-identical when optimize is false", () => {
    const off = detectLaravelWith({ framework: "laravel", optimize: false });

    expect(off.stack).toBe("laravel");
    expect(off.startCommand).toBe(STACKS.laravel.defaultStartCommand);
    expect(off.startCommand).not.toContain(WARMUP_PREFIX);
  });

  it("leaves the bare preset byte-identical when optimize is absent", () => {
    const absent = detectLaravelWith({ framework: "laravel" });

    expect(absent.stack).toBe("laravel");
    expect(absent.startCommand).toBe(STACKS.laravel.defaultStartCommand);
    expect(absent.startCommand).not.toContain(WARMUP_PREFIX);
  });

  it("uses the detected stack's optimization when the config only opts in", () => {
    const warmed = detectLaravelWith({ optimize: true });
    expect(warmed.stack).toBe("laravel");
    expect(warmed.startCommand).toBe(`${WARMUP_PREFIX}${STACKS.laravel.defaultStartCommand}`);
  });

  it("warms once before the final custom web command", () => {
    const custom = "exec php artisan octane:start --host=0.0.0.0 --port=$PORT";
    const warmed = detectLaravelWith({ optimize: true, startCommand: custom });
    expect(warmed.stack).toBe("laravel");
    expect(warmed.startCommand).toBe(`${WARMUP_PREFIX}${custom}`);
  });

  it("does not warm a non-laravel stack even when optimize is true", () => {
    const node = detectStack(
      [
        { name: "package.json", type: "file" },
        { name: "openship.json", type: "file" },
      ],
      { dependencies: { express: "^4.19.0" }, scripts: { start: "node server.js" } },
      { "openship.json": JSON.stringify({ optimize: true }) },
    );

    expect(node.stack).not.toBe("laravel");
    expect(node.startCommand).not.toContain(WARMUP_PREFIX);
  });
});
