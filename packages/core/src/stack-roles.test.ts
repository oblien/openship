import { describe, expect, it } from "vitest";

import { phpLanguageDetector } from "./languages/php";
import { parseOpenshipConfig } from "./openship-config/parse";
import { resolveStackRoles } from "./stack-roles";
import { STACKS, type StackRole } from "./stacks";

const jobs: StackRole = {
  name: "jobs",
  kind: "worker",
  command: "exec bin/jobs",
  when: { deps: ["solid_queue"], files: ["bin/jobs"] },
};
const sidekiq: StackRole = {
  name: "sidekiq",
  kind: "worker",
  command: "exec bundle exec sidekiq",
  when: { deps: ["sidekiq"] },
};
const defaultRoles = [jobs, sidekiq];

describe("resolveStackRoles", () => {
  it("returns no roles when nothing detected", () => {
    expect(resolveStackRoles({ defaultRoles, deps: [], files: [] })).toEqual([]);
  });

  it("returns no roles for an absent defaultRoles / deps / files (all optional)", () => {
    expect(resolveStackRoles({})).toEqual([]);
  });

  it("matches a preset only when every `when` signal is present", () => {
    // solid_queue gem present but bin/jobs missing - the `files` signal fails.
    expect(resolveStackRoles({ defaultRoles, deps: ["solid_queue"], files: [] })).toEqual([]);
    expect(
      resolveStackRoles({ defaultRoles, deps: ["solid_queue"], files: ["bin/jobs"] }),
    ).toEqual([jobs]);
  });

  it("matches sidekiq on its gem alone, no files signal required", () => {
    expect(resolveStackRoles({ defaultRoles, deps: ["sidekiq"], files: [] })).toEqual([sidekiq]);
  });

  it("is case-insensitive on dep names (matches how Gemfile parsing lowercases them)", () => {
    expect(resolveStackRoles({ defaultRoles, deps: ["SIDEKIQ"], files: [] })).toEqual([sidekiq]);
  });

  it("returns NO worker role when both solid_queue and sidekiq resolve - ambiguous", () => {
    expect(
      resolveStackRoles({
        defaultRoles,
        deps: ["solid_queue", "sidekiq"],
        files: ["bin/jobs"],
      }),
    ).toEqual([]);
  });

  it("excludes a preset when any `unless` dep is present", () => {
    // The shape sudanese needs for Laravel: an ungated queue worker that steps
    // aside for Horizon, rather than both matching and cancelling out.
    const queue: StackRole = {
      name: "queue",
      kind: "worker",
      command: "php artisan queue:work",
      unless: { deps: ["laravel/horizon"] },
    };
    const horizon: StackRole = {
      name: "horizon",
      kind: "worker",
      command: "php artisan horizon",
      when: { deps: ["laravel/horizon"] },
    };
    const laravelRoles = [queue, horizon];
    expect(resolveStackRoles({ defaultRoles: laravelRoles, deps: ["laravel/framework"] })).toEqual([
      queue,
    ]);
    expect(
      resolveStackRoles({ defaultRoles: laravelRoles, deps: ["laravel/horizon"] }),
    ).toEqual([horizon]);
  });

  it("excludes a preset when any `unless` file is present", () => {
    const role: StackRole = {
      name: "queue",
      kind: "worker",
      command: "php artisan queue:work",
      unless: { files: ["Procfile"] },
    };
    expect(resolveStackRoles({ defaultRoles: [role], files: [] })).toEqual([role]);
    expect(resolveStackRoles({ defaultRoles: [role], files: ["Procfile"] })).toEqual([]);
  });

  it("an explicit configRoles array replaces presets entirely", () => {
    const custom: StackRole = { name: "custom-worker", kind: "worker", command: "bin/custom" };
    expect(
      resolveStackRoles({
        defaultRoles,
        deps: ["solid_queue", "sidekiq"],
        files: ["bin/jobs"],
        configRoles: [custom],
      }),
    ).toEqual([custom]);
  });

  it("configRoles: [] is an explicit opt-out, even when presets would otherwise match", () => {
    expect(
      resolveStackRoles({
        defaultRoles,
        deps: ["solid_queue"],
        files: ["bin/jobs"],
        configRoles: [],
      }),
    ).toEqual([]);
  });
});

describe("STACKS.rails.defaultRoles (issue #935)", () => {
  it("registers the jobs and sidekiq worker presets, no scheduler", () => {
    const roles = STACKS.rails.defaultRoles;
    expect(roles?.map((r) => r.name)).toEqual(["jobs", "sidekiq"]);
    expect(roles?.every((r) => r.kind === "worker")).toBe(true);
  });

  it("resolves against Gemfile-shaped deps end to end", () => {
    expect(
      resolveStackRoles({
        defaultRoles: STACKS.rails.defaultRoles,
        deps: ["rails", "sidekiq", "pg"],
        files: [],
      }),
    ).toEqual([sidekiq]);
  });
});

describe("STACKS.laravel.defaultRoles", () => {
  it("registers the queue, horizon, and scheduler presets", () => {
    const roles = STACKS.laravel.defaultRoles;
    expect(roles?.map((r) => r.name)).toEqual(["queue", "horizon", "scheduler"]);
    expect(roles?.map((r) => r.kind)).toEqual(["worker", "worker", "scheduler"]);
    expect(roles?.map((r) => r.command)).toEqual([
      "exec php artisan queue:work",
      "exec php artisan horizon",
      "exec php artisan schedule:work",
    ]);
  });

  it("the scheduler preset is a singleton", () => {
    const scheduler = STACKS.laravel.defaultRoles?.find((r) => r.name === "scheduler");
    expect(scheduler?.singleton).toBe(true);
  });

  it("every preset sets a 90s stop grace period the openship.json parser accepts", () => {
    const roles: readonly StackRole[] = STACKS.laravel.defaultRoles ?? [];
    expect(roles.map((r) => r.stopGracePeriod)).toEqual(["90s", "90s", "90s"]);
    // Presets bypass the parser, so run each value through it here.
    const { config, errors } = parseOpenshipConfig({
      roles: roles.map(({ name, kind, command, singleton, stopGracePeriod }) => ({
        name,
        kind,
        command,
        singleton,
        stopGracePeriod,
      })),
    });
    expect(errors).toEqual([]);
    expect(config?.roles?.map((r) => r.stopGracePeriod)).toEqual(["90s", "90s", "90s"]);
  });

  // "web" is never part of defaultRoles - it is derived from
  // defaultStartCommand (see RoleKind's doc comment) - so a plain Laravel
  // project resolves to the queue + scheduler worker/scheduler roles only;
  // the web process is assumed on top of that, the same way the Rails
  // describe block above never asserts a "web" entry either.
  it("a plain Laravel project (no Horizon) resolves to queue + scheduler", () => {
    expect(
      resolveStackRoles({
        defaultRoles: STACKS.laravel.defaultRoles,
        deps: ["laravel/framework"],
        files: ["artisan", "composer.json"],
      }).map((r) => r.name),
    ).toEqual(["queue", "scheduler"]);
  });

  it("Horizon in `require` resolves to horizon + scheduler, not queue", () => {
    expect(
      resolveStackRoles({
        defaultRoles: STACKS.laravel.defaultRoles,
        deps: ["laravel/framework", "laravel/horizon"],
        files: ["artisan", "composer.json"],
      }).map((r) => r.name),
    ).toEqual(["horizon", "scheduler"]);
  });

  // These two tests run a real composer.json through phpLanguageDetector
  // itself, instead of hand-building a `deps` array. That is the only way
  // to exercise the actual require/require-dev merge in languages/php.ts
  // (php.ts:17) rather than assume it. If that merge ever stops happening,
  // the require-dev-only test below starts failing, because the detector
  // would then drop `laravel/horizon` from its output entirely.
  it("a dev-only Horizon in composer.json still resolves horizon, not queue, because the PHP detector merges require and require-dev", () => {
    const composerJson = JSON.stringify({
      require: { php: "^8.2", "laravel/framework": "^11.0" },
      "require-dev": { "laravel/horizon": "^5.0" },
    });
    const deps = Object.keys(phpLanguageDetector.parseManifest("composer.json", composerJson));
    expect(
      resolveStackRoles({
        defaultRoles: STACKS.laravel.defaultRoles,
        deps,
        files: ["artisan", "composer.json"],
      }).map((r) => r.name),
    ).toEqual(["horizon", "scheduler"]);
  });

  it("a composer.json with no Horizon at all resolves queue, not horizon", () => {
    const composerJson = JSON.stringify({
      require: { php: "^8.2", "laravel/framework": "^11.0" },
    });
    const deps = Object.keys(phpLanguageDetector.parseManifest("composer.json", composerJson));
    expect(
      resolveStackRoles({
        defaultRoles: STACKS.laravel.defaultRoles,
        deps,
        files: ["artisan", "composer.json"],
      }).map((r) => r.name),
    ).toEqual(["queue", "scheduler"]);
  });

  it("an explicit configRoles array replaces every preset, so a caller wanting the scheduler back must list it explicitly", () => {
    const customWeb: StackRole = {
      name: "worker",
      kind: "worker",
      command: "php artisan queue:work",
    };
    expect(
      resolveStackRoles({
        defaultRoles: STACKS.laravel.defaultRoles,
        deps: ["laravel/framework"],
        files: ["artisan", "composer.json"],
        configRoles: [customWeb],
      }),
    ).toEqual([customWeb]);
  });

  it("configRoles: [] opts a Laravel project out of every preset, including the scheduler", () => {
    expect(
      resolveStackRoles({
        defaultRoles: STACKS.laravel.defaultRoles,
        deps: ["laravel/framework", "laravel/horizon"],
        files: ["artisan", "composer.json"],
        configRoles: [],
      }),
    ).toEqual([]);
  });

  it("multiple explicit workers are allowed - configRoles bypasses the ambiguous-kind dedup that applies to defaultRoles", () => {
    const horizonWorker: StackRole = {
      name: "horizon",
      kind: "worker",
      command: "php artisan horizon",
    };
    const queueWorker: StackRole = {
      name: "queue",
      kind: "worker",
      command: "php artisan queue:work",
    };
    expect(
      resolveStackRoles({
        defaultRoles: STACKS.laravel.defaultRoles,
        deps: ["laravel/framework", "laravel/horizon"],
        files: ["artisan", "composer.json"],
        configRoles: [horizonWorker, queueWorker],
      }),
    ).toEqual([horizonWorker, queueWorker]);
  });
});
