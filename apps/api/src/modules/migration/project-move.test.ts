import { describe, expect, it } from "vitest";

import { assertProjectMovable, planProjectMove, ProjectMoveRefused } from "./project-move";
import type { DiscoveredService } from "./docker-reconcile";

/**
 * The refusal matrix, and the three fields whose wrong value is destructive:
 * `created` (rollback deletes what adopt created), `renames` (a wrong name orphans a
 * row from its container), and `handover` (a missing entry makes the target try to pull
 * an image that exists on no registry).
 */

const svc = (over: Partial<DiscoveredService> = {}): DiscoveredService =>
  ({
    name: "web",
    source: "compose",
    containerId: "c_web",
    running: true,
    image: "openship/web:abc123",
    ports: [],
    env: {},
    volumes: [],
    networks: [],
    dependsOn: [],
    ...over,
  }) as DiscoveredService;

const project = { id: "p1", name: "clincai", slug: "clincai", serverId: "srv_a" };

const plan = (over: Partial<Parameters<typeof planProjectMove>[0]> = {}) =>
  planProjectMove({
    project,
    targetServerId: "srv_b",
    discovered: [svc()],
    ourContainerIds: ["c_web"],
    ...over,
  });

describe("planProjectMove refusals", () => {
  it("refuses the control plane", () => {
    // Openship would be stopping the API running the migration.
    expect(() => plan({ isControlPlane: true })).toThrow(/control plane/i);
    expect(() => plan({ isControlPlane: true })).toThrow(ProjectMoveRefused);
  });

  it("refuses a project bound to no server", () => {
    expect(() => plan({ project: { ...project, serverId: null } })).toThrow(/isn't bound to a server/);
  });

  it("refuses a move onto the server it already runs on", () => {
    // Nothing to transfer, and the pipeline's same-server path means something else
    // entirely (attach-in-place), which is not what this door offers.
    expect(() => plan({ targetServerId: "srv_a" })).toThrow(/already runs on that server/);
  });

  it("refuses when no live container carries the project's label", () => {
    expect(() => plan({ ourContainerIds: [] })).toThrow(/No running containers/);
  });

  it("refuses a service that builds from source with no image", () => {
    expect(() =>
      plan({ discovered: [svc({ build: ".", image: undefined })] }),
    ).toThrow(/no published image: web/);
  });

  it("carries the offending names into the build-from-source message", () => {
    // The operator has to know WHICH service to fix.
    expect(() =>
      plan({
        discovered: [
          svc({ name: "web", containerId: "c_web", build: ".", image: undefined }),
          svc({ name: "api", containerId: "c_api", build: ".", image: undefined }),
        ],
        ourContainerIds: ["c_web", "c_api"],
      }),
    ).toThrow(/web, api/);
  });

  it("exposes a code for every refusal", () => {
    const codes = [
      [() => plan({ isControlPlane: true }), "control_plane"],
      [() => plan({ project: { ...project, serverId: null } }), "not_server_hosted"],
      [() => plan({ targetServerId: "srv_a" }), "same_server"],
      [() => plan({ ourContainerIds: [] }), "nothing_running"],
      [() => plan({ discovered: [svc({ build: ".", image: undefined })] }), "builds_from_source"],
    ] as const;
    for (const [fn, code] of codes) {
      try {
        fn();
        throw new Error(`expected a refusal for ${code}`);
      } catch (err) {
        expect((err as ProjectMoveRefused).code).toBe(code);
      }
    }
  });
});

describe("planProjectMove workload", () => {
  it("selects by container identity, never by name", () => {
    // The flat-docker pool is the WHOLE host: a neighbouring stack's `postgres` sits in
    // it. Matching on name is how a migration walks off with someone else's database.
    const out = plan({
      discovered: [
        svc({ name: "postgres", containerId: "c_ours" }),
        svc({ name: "postgres", containerId: "c_theirs" }),
      ],
      ourContainerIds: ["c_ours"],
    });
    expect(out.chosen.map((s) => s.containerId)).toEqual(["c_ours"]);
  });

  it("ignores a discovered service with no container id", () => {
    // Declared-but-not-running: there is nothing to stop, copy, or cut over.
    const out = plan({
      discovered: [svc(), svc({ name: "worker", containerId: undefined })],
      ourContainerIds: ["c_web"],
    });
    expect(out.chosen.map((s) => s.name)).toEqual(["web"]);
  });

  it("never reports the project as created", () => {
    // The orchestrator tears down `createdProjectId` on rollback. True here deletes the
    // operator's real project on any failure.
    expect(plan().adopt.created).toBe(false);
  });

  it("uses the project's own id and slug rather than minting one", () => {
    expect(plan().adopt).toMatchObject({ projectId: "p1", slug: "clincai" });
  });

  it("renames nothing", () => {
    // Rows already carry their final names. A rename map here would decouple a row from
    // the container id keyed against it.
    expect(plan().adopt.renames).toEqual({});
  });

  it("hands over the running image for every moved service", () => {
    // Our images are OUR builds: the tag exists on the source host and in no registry,
    // so without a handover the target deploy tries to pull it and fails.
    const out = plan({
      discovered: [
        svc({ name: "web", containerId: "c_web", image: "openship/web:abc" }),
        svc({ name: "db", containerId: "c_db", image: "postgres:16" }),
      ],
      ourContainerIds: ["c_web", "c_db"],
    });
    expect(out.adopt.handover).toEqual({ web: "openship/web:abc", db: "postgres:16" });
  });

  it("omits a service with no image from the handover", () => {
    const out = plan({ discovered: [svc({ image: undefined })], ourContainerIds: ["c_web"] });
    expect(out.adopt.handover).toEqual({});
  });

  it("reports the project's current server as the source", () => {
    expect(plan().sourceServerId).toBe("srv_a");
  });

  it("lists the adopted names for the run log", () => {
    expect(plan().adopt.adopted).toEqual(["web"]);
  });
});

/**
 * SERVICE-level scope. Copy only — and the asymmetry is the data model, not an omission:
 * `project.serverId` is a single durable binding, so a project cannot have containers on
 * two hosts.
 */
describe("planProjectMove service scope", () => {
  const twoSvc = {
    discovered: [
      svc({ name: "web", containerId: "c_web" }),
      svc({ name: "db", containerId: "c_db", image: "postgres:16" }),
    ],
    ourContainerIds: ["c_web", "c_db"],
  };

  it("copies just the named service", () => {
    const out = plan({ ...twoSvc, intent: "copy", serviceNames: ["db"] });
    expect(out.chosen.map((s) => s.name)).toEqual(["db"]);
    expect(out.adopt.handover).toEqual({ db: "postgres:16" });
  });

  it("refuses a scoped MOVE and points at the copy", () => {
    // Splitting a project across two servers has no representation.
    expect(() => plan({ ...twoSvc, intent: "move", serviceNames: ["db"] })).toThrow(
      /bound to one server/,
    );
    try {
      plan({ ...twoSvc, intent: "move", serviceNames: ["db"] });
    } catch (err) {
      expect((err as ProjectMoveRefused).code).toBe("scoped_move");
    }
  });

  it("takes every service when the scope is absent or empty", () => {
    expect(plan({ ...twoSvc, intent: "copy" }).chosen).toHaveLength(2);
    expect(plan({ ...twoSvc, intent: "copy", serviceNames: [] }).chosen).toHaveLength(2);
  });

  it("names a service it couldn't find rather than copying a partial set", () => {
    // Silently copying only what matched would hand back a "successful" duplicate that is
    // quietly missing a service.
    expect(() =>
      plan({ ...twoSvc, intent: "copy", serviceNames: ["db", "worker"] }),
    ).toThrow(/No running container for: worker/);
  });

  it("scopes INSIDE the project's own containers, never the whole host", () => {
    // The flat pool holds a neighbour's `db`. Scoping by name before the ownership filter
    // would copy their database.
    const out = plan({
      discovered: [
        svc({ name: "db", containerId: "c_ours" }),
        svc({ name: "db", containerId: "c_theirs" }),
      ],
      ourContainerIds: ["c_ours"],
      intent: "copy",
      serviceNames: ["db"],
    });
    expect(out.chosen.map((s) => s.containerId)).toEqual(["c_ours"]);
  });
});

/**
 * Refusals are the main thing this flow SAYS to an operator, so the wording is part of the
 * contract — and the same-server one had a specific failure of it.
 *
 * `"clincai" already runs on that server.` reached a user as `API 400: Bad Request` (the client
 * read `err.message` instead of the body), and once shown, "that server" confirmed whatever they
 * already believed. After a migration that rolled back, where the project lives is exactly the
 * thing their mental model has wrong.
 */
describe("the same-server refusal names the server", () => {
  const onSame = (sourceServerName?: string | null) => {
    try {
      assertProjectMovable({ project, targetServerId: "srv_a", sourceServerName });
      return null;
    } catch (err) {
      return err as ProjectMoveRefused;
    }
  };

  it("states where the project actually is", () => {
    const err = onSame("Server 1");
    expect(err?.message).toContain("Server 1");
    expect(err?.message).not.toContain("that server");
  });

  it("tells the operator what to do next", () => {
    expect(onSame("Server 1")?.message).toContain("Pick a different destination");
  });

  it("still refuses, with the generic wording, when the name is unavailable", () => {
    // A server row we couldn't read must not turn a clear refusal into a crash.
    expect(onSame(null)?.code).toBe("same_server");
    expect(onSame(undefined)?.message).toContain("already runs on that server");
  });

  it("keeps the machine-readable code, which the client branches on", () => {
    expect(onSame("Server 1")?.code).toBe("same_server");
  });
});
