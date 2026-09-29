import { describe, expect, it } from "vitest";

import { resolveStackRoles } from "./stack-roles";
import { STACKS, type StackRole } from "./stacks";

const jobs: StackRole = {
  name: "jobs",
  kind: "worker",
  command: "bin/jobs",
  when: { deps: ["solid_queue"], files: ["bin/jobs"] },
};
const sidekiq: StackRole = {
  name: "sidekiq",
  kind: "worker",
  command: "bundle exec sidekiq",
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
