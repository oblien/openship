import { describe, it, expect } from "vitest";
import {
  canonicalServiceContainerName,
  describeLiveState,
  liveContainerStatus,
  resolveLiveServiceState,
  type LiveContainerLike,
} from "./live-state";

const container = (over: Partial<LiveContainerLike> & { id: string }): LiveContainerLike => ({
  names: [],
  state: "running",
  status: "Up 2 hours",
  labels: {},
  ports: [],
  ...over,
});

describe("liveContainerStatus", () => {
  it("reports a crash-looping container as restarting, NOT running", () => {
    // The regression that made a crash-looping api render a green "Running":
    // docker's `restarting` state was mapped to running.
    expect(liveContainerStatus({ state: "restarting", status: "Restarting (1) 44 seconds ago" })).toBe(
      "restarting",
    );
  });

  it("reads the health suffix off the status line", () => {
    expect(liveContainerStatus({ state: "running", status: "Up 2 days (healthy)" })).toBe("running");
    expect(liveContainerStatus({ state: "running", status: "Up 2 days (unhealthy)" })).toBe("failed");
    expect(liveContainerStatus({ state: "running", status: "Up 5 seconds (health: starting)" })).toBe(
      "starting",
    );
  });

  it("maps the non-serving states", () => {
    expect(liveContainerStatus({ state: "exited", status: "Exited (0) 1 hour ago" })).toBe("stopped");
    // A non-zero exit is still "stopped": `docker stop` can exit non-zero, and a
    // user-initiated stop must not render as a crash.
    expect(liveContainerStatus({ state: "exited", status: "Exited (137) 1 hour ago" })).toBe("stopped");
    expect(liveContainerStatus({ state: "created", status: "Created" })).toBe("stopped");
    expect(liveContainerStatus({ state: "paused", status: "Up 3 days (Paused)" })).toBe("stopped");
    expect(liveContainerStatus({ state: "dead", status: "Dead" })).toBe("failed");
  });
});

describe("canonicalServiceContainerName", () => {
  it("mirrors the name createServiceContainer mints", () => {
    expect(canonicalServiceContainerName("openship", "web")).toBe("openship-openship-web");
  });
  it("is null without a slug (never matches a bare name)", () => {
    expect(canonicalServiceContainerName("", "web")).toBeNull();
  });
});

describe("resolveLiveServiceState", () => {
  const services = [
    { id: "svc_web", name: "web" },
    { id: "svc_api", name: "api" },
  ];

  it("matches a natively deployed container by openship.project + openship.service", () => {
    const live = [
      container({
        id: "c_api",
        names: ["openship-openship-api"],
        labels: { "openship.project": "proj_1", "openship.service": "api", "openship.deployment": "dep_2" },
        ip: "172.18.0.5",
        ports: [{ privatePort: 4000, publicPort: 4000 }],
        image: "openship/openship-api:bld_x",
      }),
    ];
    const m = resolveLiveServiceState({ services, live, projectId: "proj_1", slug: "openship" });
    expect(m.get("svc_api")).toMatchObject({
      containerId: "c_api",
      status: "running",
      matchedBy: "label",
      ip: "172.18.0.5",
      hostPort: 4000,
      image: "openship/openship-api:bld_x",
    });
  });

  it("resolves a migration-ATTACHED container that carries the OLD project/deployment labels", () => {
    // The reported bug: same-server "reuse" adopts the running container in
    // place. Labels are immutable, so it still says proj_OLD/dep_OLD and a
    // label-filtered `docker ps` misses it → the panel said "Stopped" while
    // `docker ps` said "Up 2 hours". The canonical NAME still identifies it.
    const live = [
      container({
        id: "c_web_old",
        names: ["openship-openship-web"],
        labels: {
          "openship.project": "proj_OLD",
          "openship.service": "web",
          "openship.deployment": "dep_OLD",
        },
      }),
    ];
    const m = resolveLiveServiceState({
      services,
      live,
      projectId: "proj_NEW",
      slug: "openship",
      trackedIds: { svc_web: "c_web_old" },
    });
    expect(m.get("svc_web")).toMatchObject({
      containerId: "c_web_old",
      status: "running",
      matchedBy: "name",
    });
  });

  it("falls back to the tracked container id for an adopted FOREIGN container name", () => {
    const live = [
      container({
        id: "abcdef0123456789",
        names: ["my_stack_db_1"],
        labels: { "com.docker.compose.project": "my_stack", "com.docker.compose.service": "db" },
        state: "restarting",
        status: "Restarting (1) 3 seconds ago",
      }),
    ];
    const m = resolveLiveServiceState({
      services: [{ id: "svc_pg", name: "postgres" }],
      live,
      projectId: "proj_NEW",
      slug: "openship",
      trackedIds: { svc_pg: "abcdef0123456789" },
    });
    expect(m.get("svc_pg")).toMatchObject({
      containerId: "abcdef0123456789",
      status: "restarting",
      matchedBy: "trackedId",
    });
  });

  it("ignores a tracked id too short to be unique", () => {
    const live = [container({ id: "abcdef0123456789", names: ["x"] })];
    const m = resolveLiveServiceState({
      services: [{ id: "svc_pg", name: "postgres" }],
      live,
      projectId: "p",
      slug: "openship",
      trackedIds: { svc_pg: "abcdef" },
    });
    expect(m.get("svc_pg")?.containerId).toBeNull();
  });

  it("matches an adopted compose stack the operator recreated out-of-band", () => {
    const live = [
      container({
        id: "c_kong",
        names: ["supabase-kong-1"],
        labels: { "com.docker.compose.project": "supabase", "com.docker.compose.service": "kong" },
      }),
    ];
    const m = resolveLiveServiceState({
      services: [{ id: "svc_kong", name: "kong" }],
      live,
      projectId: "proj_1",
      slug: "supabase",
    });
    expect(m.get("svc_kong")).toMatchObject({ containerId: "c_kong", matchedBy: "compose" });
  });

  it("prefers a live label match over a stale tracked id", () => {
    const live = [
      container({ id: "c_stale", names: ["openship-openship-web-old"], state: "exited", status: "Exited (0)" }),
      container({
        id: "c_fresh",
        names: ["openship-openship-web"],
        labels: { "openship.project": "proj_1", "openship.service": "web" },
      }),
    ];
    const m = resolveLiveServiceState({
      services: [{ id: "svc_web", name: "web" }],
      live,
      projectId: "proj_1",
      slug: "openship",
      trackedIds: { svc_web: "c_stale_0000000000" },
    });
    expect(m.get("svc_web")).toMatchObject({ containerId: "c_fresh", matchedBy: "label" });
  });

  it("prefers the running candidate when two containers share one identity", () => {
    const live = [
      container({
        id: "c_dead",
        names: ["a"],
        labels: { "openship.project": "proj_1", "openship.service": "web" },
        state: "exited",
        status: "Exited (1) 2 minutes ago",
      }),
      container({
        id: "c_up",
        names: ["b"],
        labels: { "openship.project": "proj_1", "openship.service": "web" },
      }),
    ];
    const m = resolveLiveServiceState({
      services: [{ id: "svc_web", name: "web" }],
      live,
      projectId: "proj_1",
      slug: "openship",
    });
    expect(m.get("svc_web")?.containerId).toBe("c_up");
    expect(m.get("svc_web")?.duplicates).toEqual(["a"]);
  });

  it("reports a DUPLICATE when a second container also answers to the service", () => {
    // Adopted container (foreign name, tracked id) + a later deploy under the
    // canonical name: the canonical one wins, the adopted one is surfaced.
    const live = [
      container({ id: "abcdef0123456789", names: ["legacy_web_1"] }),
      container({
        id: "c_new",
        names: ["openship-openship-web"],
        labels: { "openship.project": "proj_1", "openship.service": "web" },
      }),
    ];
    const m = resolveLiveServiceState({
      services: [{ id: "svc_web", name: "web" }],
      live,
      projectId: "proj_1",
      slug: "openship",
      trackedIds: { svc_web: "abcdef0123456789" },
    });
    expect(m.get("svc_web")?.containerId).toBe("c_new");
    expect(m.get("svc_web")?.duplicates).toEqual(["legacy_web_1"]);
  });

  it("never lets two services claim the same container", () => {
    const live = [
      container({
        id: "c_only",
        names: ["openship-openship-web"],
        labels: { "openship.project": "proj_1", "openship.service": "web" },
      }),
    ];
    const m = resolveLiveServiceState({
      services: [
        { id: "svc_web", name: "web" },
        // A second row whose tracked id points at the SAME container (a bad
        // migration hint) must not double-claim it.
        { id: "svc_web2", name: "web-2" },
      ],
      live,
      projectId: "proj_1",
      slug: "openship",
      trackedIds: { svc_web2: "c_only_0000000000" },
    });
    expect(m.get("svc_web")?.containerId).toBe("c_only");
    expect(m.get("svc_web2")?.containerId).toBeNull();
  });

  it("reports stopped for a service with no container on the host", () => {
    const m = resolveLiveServiceState({
      services: [{ id: "svc_web", name: "web" }],
      live: [container({ id: "c_other", names: ["unrelated"] })],
      projectId: "proj_1",
      slug: "openship",
    });
    expect(m.get("svc_web")).toMatchObject({ containerId: null, status: "stopped", matchedBy: null });
  });

  it("does not match another project's container by name when slugs differ", () => {
    const m = resolveLiveServiceState({
      services: [{ id: "svc_web", name: "web" }],
      live: [container({ id: "c_other", names: ["openship-otherproject-web"] })],
      projectId: "proj_1",
      slug: "openship",
    });
    expect(m.get("svc_web")?.containerId).toBeNull();
  });
});

// Project teardown now reclaims containers through this matcher (the label sweep
// alone misses an adopted one, which then survived the delete and fought the next
// deploy for its ports). That makes these two properties load-bearing for a
// DESTRUCTIVE path, so they get their own guarantees.
describe("resolveLiveServiceState — teardown safety", () => {
  it("reclaims an adopted container whose openship.project names ANOTHER project", () => {
    const live = [
      container({
        id: "c_adopted",
        names: ["openship-openship-postgres"],
        labels: { "openship.project": "proj_PREVIOUS", "openship.service": "postgres" },
      }),
    ];
    const m = resolveLiveServiceState({
      services: [{ id: "svc_pg", name: "postgres" }],
      live,
      projectId: "proj_CURRENT",
      slug: "openship",
    });
    expect(m.get("svc_pg")?.containerId).toBe("c_adopted");
  });

  it("never claims a container that belongs to a different project's stack", () => {
    const live = [
      // Same service NAME, different project: different canonical name, different
      // project label, different compose project. Nothing may match.
      container({
        id: "c_theirs",
        names: ["openship-otherapp-postgres"],
        labels: {
          "openship.project": "proj_THEIRS",
          "openship.service": "postgres",
          "com.docker.compose.project": "otherapp",
          "com.docker.compose.service": "postgres",
        },
      }),
    ];
    const m = resolveLiveServiceState({
      services: [{ id: "svc_pg", name: "postgres" }],
      live,
      projectId: "proj_CURRENT",
      slug: "openship",
    });
    expect(m.get("svc_pg")?.containerId).toBeNull();
  });
});

describe("describeLiveState", () => {
  it("names the container, state and identity key per service", () => {
    const services = [
      { id: "svc_web", name: "web" },
      { id: "svc_api", name: "api" },
    ];
    const live = [container({ id: "c_web", names: ["openship-openship-web"] })];
    const matches = resolveLiveServiceState({ services, live, projectId: "p", slug: "openship" });
    expect(describeLiveState(services, live, matches)).toEqual([
      "web → openship-openship-web (running, by name)",
      "api → NO container on the host",
    ]);
  });
});

describe("resolveLiveServiceState — restricted tiers (destructive callers)", () => {
  const composeOnly = [
    container({
      id: "c_kept_original",
      names: ["supabase-db-1"],
      labels: { "com.docker.compose.project": "supabase", "com.docker.compose.service": "db" },
    }),
  ];
  const services = [{ id: "svc_db", name: "db" }];

  it("matches a compose-labelled container by default (READ path)", () => {
    const m = resolveLiveServiceState({
      services,
      live: composeOnly,
      projectId: "proj_1",
      slug: "supabase",
    });
    expect(m.get("svc_db")).toMatchObject({ containerId: "c_kept_original", matchedBy: "compose" });
  });

  it("does NOT match it when the caller restricts to ownership-proving keys", () => {
    // The teardown case: a migration that KEPT its source leaves the original
    // stack running under the same compose project name. Sweeping it on delete
    // would destroy containers + volumes the operator deliberately kept.
    const m = resolveLiveServiceState({
      services,
      live: composeOnly,
      projectId: "proj_1",
      slug: "supabase",
      tiers: ["label", "name", "trackedId"],
    });
    expect(m.get("svc_db")?.containerId).toBeNull();
  });

  it("still reclaims what it owns under the restriction", () => {
    const live = [
      container({
        id: "c_ours",
        names: ["openship-supabase-db"],
        labels: { "openship.project": "proj_1", "openship.service": "db" },
      }),
      ...composeOnly,
    ];
    const m = resolveLiveServiceState({
      services,
      live,
      projectId: "proj_1",
      slug: "supabase",
      tiers: ["label", "name", "trackedId"],
    });
    expect(m.get("svc_db")?.containerId).toBe("c_ours");
  });
});
