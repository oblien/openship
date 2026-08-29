import { describe, expect, it } from "vitest";

import { perService, selectDiscoveredServices, serviceUid } from "./select-services";
import type { DiscoveredService } from "./docker-reconcile";

/**
 * GH-584: migrating a foreign compose stack failed with `already managed here by
 * project "Openship"`, unretryably, on every server running Openship itself.
 *
 * The cause was a selection resolved by BARE SERVICE NAME against a server-wide
 * pool. A compose service name is unique only within its own project, and
 * Openship's control-plane stack has services named `api`, `dashboard`, `edge`,
 * `postgres`, `redis` — so migrating anything with a `postgres` matched a seventh
 * container: ours.
 *
 * The fixture is the reporter's actual server.
 */

const svc = (name: string, containerId: string | undefined, project: string): DiscoveredService =>
  ({
    name,
    source: "compose",
    containerId,
    running: true,
    ports: [],
    env: {},
    volumes: [],
    networks: [],
    dependsOn: [],
    // Not read by the resolver; carried so the fixture reads like the real object.
    composeProject: project,
  }) as unknown as DiscoveredService;

/** The reporter's host: their `dependabot` stack + Openship's own control plane. */
const POOL: DiscoveredService[] = [
  svc("background-tasks", "c-bg", "dependabot"),
  svc("worker", "c-worker", "dependabot"),
  svc("web", "c-web", "dependabot"),
  svc("migration", "c-migration", "dependabot"),
  svc("postgres", "c-dependabot-pg", "dependabot"),
  svc("docker", "c-docker", "dependabot"),
  // Openship itself, on the same box. No `openship.*` labels, so the scan leaves
  // these in the generic candidate pool.
  svc("api", "c-openship-api", "openship"),
  svc("dashboard", "c-openship-dash", "openship"),
  svc("postgres", "c-openship-pg", "openship"),
  svc("redis", "c-openship-redis", "openship"),
];

const DEPENDABOT_NAMES = ["background-tasks", "worker", "web", "migration", "postgres", "docker"];
const DEPENDABOT_IDS = ["c-bg", "c-worker", "c-web", "c-migration", "c-dependabot-pg", "c-docker"];

describe("selectDiscoveredServices — identity scoping (#584)", () => {
  it("selects exactly the picked containers, not same-named ones from other stacks", () => {
    const got = selectDiscoveredServices(POOL, {
      containerIds: DEPENDABOT_IDS,
      names: DEPENDABOT_NAMES,
    });
    expect(got.map((s) => s.containerId)).toEqual(DEPENDABOT_IDS);
    // The whole bug in one assertion: Openship's own postgres must not be here.
    expect(got.map((s) => s.containerId)).not.toContain("c-openship-pg");
    expect(got).toHaveLength(6);
  });

  it("reproduces the bug when ids are absent — the legacy name match is ambiguous", () => {
    // Pinned deliberately: this is what an older client still sends, and it is why
    // the control-plane exclusion in excludeAlreadyManaged has to exist.
    const got = selectDiscoveredServices(POOL, { names: DEPENDABOT_NAMES });
    expect(got).toHaveLength(7);
    expect(got.map((s) => s.containerId)).toContain("c-openship-pg");
  });

  it("ignores a name that was not picked even when its id is unknown", () => {
    const got = selectDiscoveredServices(POOL, { containerIds: ["c-web"], names: ["web"] });
    expect(got.map((s) => s.containerId)).toEqual(["c-web"]);
  });

  it("still honors names for pool entries that have NO container id", () => {
    // A declared-but-not-running service cannot collide by id, so a mixed selection
    // (running container + declared-only service) must stay whole.
    const pool = [...POOL, svc("redis-declared", undefined, "dependabot")];
    const got = selectDiscoveredServices(pool, {
      containerIds: ["c-web"],
      names: ["web", "redis-declared"],
    });
    expect(got.map((s) => s.name).sort()).toEqual(["redis-declared", "web"]);
  });

  it("does not treat an empty id list as 'match nothing'", () => {
    // An empty array must fall back to names, not silently select zero services —
    // that would turn the fix into 'None of the selected services were found'.
    const got = selectDiscoveredServices(POOL, { containerIds: [], names: ["web"] });
    expect(got.map((s) => s.containerId)).toEqual(["c-web"]);
  });

  it("ignores blank ids rather than counting them as a selector", () => {
    const got = selectDiscoveredServices(POOL, { containerIds: ["", "c-web"], names: [] });
    expect(got.map((s) => s.containerId)).toEqual(["c-web"]);
  });

  it("keys a service by its container id, and by name only when it has none", () => {
    expect(serviceUid(svc("web", "c-web", "app"))).toBe("c-web");
    // A compose file declares it but nothing runs it — name is all there is, and the
    // server's name fallback exists for exactly this case.
    expect(serviceUid(svc("redis", undefined, "app"))).toBe("redis");
  });

  it("selects nothing when neither selector matches", () => {
    expect(selectDiscoveredServices(POOL, { containerIds: ["nope"], names: [] })).toEqual([]);
    expect(selectDiscoveredServices(POOL, { names: ["nope"] })).toEqual([]);
  });
});

describe("perService — per-service inputs cannot cross-apply (#584 class)", () => {
  const ours = svc("postgres", "c-openship-pg", "openship");
  const theirs = svc("postgres", "c-dependabot-pg", "dependabot");

  it("gives each same-named service its OWN value", () => {
    // The defect this closes: both were keyed as "postgres", so whichever the client
    // wrote last decided the volume strategy for BOTH — silently copying a volume the
    // operator asked to reuse in place, or attaching one they asked to copy.
    const map = { "c-openship-pg": "reuse", "c-dependabot-pg": "copy" } as const;
    expect(perService(map, ours)).toBe("reuse");
    expect(perService(map, theirs)).toBe("copy");
  });

  it("falls back to the name for an older client that sends name keys", () => {
    expect(perService({ postgres: "copy" }, theirs)).toBe("copy");
  });

  it("prefers the id entry over a name entry for the same service", () => {
    expect(perService({ postgres: "copy", "c-dependabot-pg": "reuse" }, theirs)).toBe("reuse");
  });

  it("reads the name entry when a service has no container", () => {
    const declared = svc("redis", undefined, "dependabot");
    expect(perService({ redis: "copy" }, declared)).toBe("copy");
  });

  it("returns undefined for an absent map or an unconfigured service", () => {
    expect(perService(undefined, theirs)).toBeUndefined();
    expect(perService({ other: "copy" }, theirs)).toBeUndefined();
  });
});
