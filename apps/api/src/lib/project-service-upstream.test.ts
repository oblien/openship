import { describe, expect, it } from "vitest";
import { parseServiceHostPort, parseServicePort } from "./deployable-service";
import { parseComposePort } from "../modules/migration/docker-reconcile";
import {
  buildProjectServiceUpstream,
  describeCandidatePorts,
  pickProjectPortOwner,
  resolveProjectServiceUpstream,
} from "./project-service-upstream";

/**
 * The adopted stack from #618. postgres comes FIRST, and nothing is `exposed` —
 * adoption leaves every service unexposed on purpose, so the port match cannot lean
 * on that flag to find the app.
 */
const services = [
  { id: "svc-postgres", name: "postgres", enabled: true, exposed: false, ports: ["5432"] },
  { id: "svc-web", name: "web", enabled: true, exposed: false, ports: ["3000:3000"] },
  { id: "svc-worker", name: "worker", enabled: true, exposed: false, ports: [] },
];

const rows = new Map([
  ["svc-postgres", { serviceId: "svc-postgres", containerId: "c-postgres", ip: "10.0.0.3" }],
  ["svc-web", { serviceId: "svc-web", containerId: "c-web", ip: "10.0.0.2", hostPort: 3000 }],
  ["svc-worker", { serviceId: "svc-worker", containerId: "c-worker", ip: "10.0.0.4" }],
]);

describe("parseServiceHostPort", () => {
  it("reads the published half of a mapping", () => {
    expect(parseServiceHostPort("8080:3000")).toBe(8080);
  });

  it("reads the published half of an interface-scoped mapping", () => {
    expect(parseServiceHostPort("127.0.0.1:8080:3000")).toBe(8080);
  });

  it("ignores the protocol suffix", () => {
    expect(parseServiceHostPort("8080:3000/tcp")).toBe(8080);
  });

  it("returns null for a container-only port (docker picks the host side)", () => {
    expect(parseServiceHostPort("3000")).toBeNull();
  });

  it("returns null for a RANGE, which names no single port", () => {
    expect(parseServiceHostPort("3000-3005:3000")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(parseServiceHostPort(undefined)).toBeNull();
    expect(parseServiceHostPort("")).toBeNull();
  });

  /**
   * DRIFT GUARD. `parseComposePort` (migration) answers the same two questions for
   * edge detection and publish stripping, and `lib/` cannot import from `modules/`.
   * If the two ever disagree, a route the operator points at a published port stops
   * resolving to the service whose publish the migration stripped — so pin them to
   * the same answer here rather than trusting the comment.
   */
  it("agrees with parseComposePort on every real compose port form", () => {
    for (const spec of [
      "3000",
      "3000/tcp",
      "3000/udp",
      "8080:3000",
      "8080:3000/tcp",
      "8080:3000/udp",
      "127.0.0.1:8080:3000",
      "0.0.0.0:8080:3000",
      "::1:8080:3000",
      "3000-3005:3000-3005",
      "80:80",
      "443:443",
    ]) {
      const parsed = parseComposePort(spec);
      expect({ spec, host: parseServiceHostPort(spec) }).toEqual({ spec, host: parsed.host });
      // The container half too, so neither accessor drifts off the shared rule.
      expect({ spec, container: parseServicePort(spec) }).toEqual({
        spec,
        container: parseServicePort(parsed.container),
      });
    }
  });
});

describe("pickProjectPortOwner", () => {
  it("matches the service that listens on the route's port", () => {
    expect(pickProjectPortOwner({ port: 3000, services, rowByService: rows })).toEqual({
      serviceId: "svc-web",
      serviceName: "web",
      containerPort: 3000,
      via: "container-port",
    });
  });

  it("does not answer with the dependency-ordered first service", () => {
    // `find(s => s.containerId)` over this list answers postgres — the #498 trap.
    expect(pickProjectPortOwner({ port: 3000, services, rowByService: rows })?.serviceId).not.toBe(
      "svc-postgres",
    );
  });

  it("matches a route pointed at the PUBLISHED port and reports the container port", () => {
    const mapped = [
      services[0],
      { id: "svc-web", name: "web", enabled: true, exposed: false, ports: ["8080:3000"] },
    ];
    expect(pickProjectPortOwner({ port: 8080, services: mapped, rowByService: rows })).toEqual({
      serviceId: "svc-web",
      serviceName: "web",
      containerPort: 3000,
      via: "published-port",
    });
  });

  it("matches the host port the row was last observed publishing", () => {
    // The port is on neither side of any `ports` entry — only the live row knows it.
    const undeclared = [{ id: "svc-web", name: "web", enabled: true, exposed: true, ports: [] }];
    expect(
      pickProjectPortOwner({
        port: 32770,
        services: undeclared,
        rowByService: new Map([
          ["svc-web", { serviceId: "svc-web", containerId: "c-web", hostPort: 32770 }],
        ]),
      }),
    ).toMatchObject({ serviceId: "svc-web", via: "published-port" });
  });

  it("prefers the EXPOSED service when two declare the same port", () => {
    const clash = [
      { id: "svc-internal", name: "internal", enabled: true, exposed: false, ports: ["3000"] },
      { id: "svc-web", name: "web", enabled: true, exposed: true, ports: ["3000"] },
    ];
    expect(
      pickProjectPortOwner({
        port: 3000,
        services: clash,
        rowByService: new Map([
          ["svc-internal", { serviceId: "svc-internal", containerId: "c-int" }],
          ["svc-web", { serviceId: "svc-web", containerId: "c-web" }],
        ]),
      })?.serviceId,
    ).toBe("svc-web");
  });

  it("reads exposedPort, which outranks the ports list", () => {
    const withExposedPort = [
      {
        id: "svc-api",
        name: "api",
        enabled: true,
        exposed: true,
        exposedPort: "4000",
        ports: ["5000"],
      },
    ];
    expect(
      pickProjectPortOwner({
        port: 4000,
        services: withExposedPort,
        rowByService: new Map([["svc-api", { serviceId: "svc-api", containerId: "c-api" }]]),
      }),
    ).toMatchObject({ serviceId: "svc-api", containerPort: 4000, via: "container-port" });
  });

  it("refuses to guess when NO service declares the route's port", () => {
    // Answering "the primary service" here would proxy a public domain at whatever the
    // list starts with — on an adopted stack, the database. The caller falls back to
    // the release's own primary container, or skips the route and says why.
    expect(pickProjectPortOwner({ port: 9999, services, rowByService: rows })).toBeNull();
  });

  it("breaks a tie on the canonical domain row, so it agrees with the access URL", () => {
    const clash = [
      { id: "svc-a", name: "a", enabled: true, exposed: true, ports: ["3000"] },
      { id: "svc-b", name: "b", enabled: true, exposed: true, ports: ["3000"] },
    ];
    const clashRows = new Map([
      ["svc-a", { serviceId: "svc-a", containerId: "c-a" }],
      ["svc-b", { serviceId: "svc-b", containerId: "c-b" }],
    ]);
    // Without the domain row, list order decides; with it, the canonical row wins —
    // the same answer `deployment.containerId` held (pickPrimaryServiceId).
    expect(
      pickProjectPortOwner({ port: 3000, services: clash, rowByService: clashRows })?.serviceId,
    ).toBe("svc-a");
    expect(
      pickProjectPortOwner({
        port: 3000,
        services: clash,
        rowByService: clashRows,
        domainRows: [{ verified: true, isPrimary: true, serviceId: "svc-b" }],
      })?.serviceId,
    ).toBe("svc-b");
  });

  it("ignores a service with no live container", () => {
    // Only postgres has a container, and it does not declare 3000 → no match at all,
    // rather than postgres by default.
    expect(
      pickProjectPortOwner({
        port: 3000,
        services,
        rowByService: new Map([
          ["svc-postgres", { serviceId: "svc-postgres", containerId: "c-postgres" }],
        ]),
      }),
    ).toBeNull();
  });

  it("ignores a DISABLED service even when a stale row still names its container", () => {
    const disabled = [
      { id: "svc-web", name: "web", enabled: false, exposed: true, ports: ["3000"] },
    ];
    expect(
      pickProjectPortOwner({
        port: 3000,
        services: disabled,
        rowByService: new Map([["svc-web", { serviceId: "svc-web", containerId: "c-web" }]]),
      }),
    ).toBeNull();
  });

  it("returns null when no service has a container to route to", () => {
    expect(
      pickProjectPortOwner({
        port: 3000,
        services,
        rowByService: new Map([["svc-web", { serviceId: "svc-web", containerId: null }]]),
      }),
    ).toBeNull();
  });
});

describe("resolveProjectServiceUpstream", () => {
  const containerIpRuntime = {
    name: "docker" as const,
    supports: (cap: string) => cap === "containerIp",
    getContainerIp: async (id: string) =>
      ({ "c-web": "10.0.0.2", "c-postgres": "10.0.0.3", "c-worker": "10.0.0.4" })[id] ?? null,
  };

  it("dials the owner's container IP at the port it listens on", async () => {
    const resolved = await resolveProjectServiceUpstream({
      strategy: "container-ip",
      runtime: containerIpRuntime,
      port: 3000,
      services,
      rowByService: rows,
    });
    expect(resolved?.url).toBe("http://10.0.0.2:3000");
    expect(resolved?.owner.serviceName).toBe("web");
  });

  it("dials the container port, not the host port, for a published-port match", async () => {
    const mapped = [
      { id: "svc-web", name: "web", enabled: true, exposed: true, ports: ["8080:3000"] },
    ];
    const resolved = await resolveProjectServiceUpstream({
      strategy: "container-ip",
      runtime: containerIpRuntime,
      port: 8080,
      services: mapped,
      rowByService: rows,
    });
    expect(resolved?.url).toBe("http://10.0.0.2:3000");
  });

  it("returns null when no service owns the port", async () => {
    expect(
      await resolveProjectServiceUpstream({
        strategy: "container-ip",
        runtime: containerIpRuntime,
        port: 3000,
        services: [],
        rowByService: new Map(),
      }),
    ).toBeNull();
  });
});

describe("pickProjectPortOwner multi-publish pairing", () => {
  const multi = [
    {
      id: "svc-convex",
      name: "convex",
      enabled: true,
      exposed: false,
      ports: ["8080:3000", "9090:4000"],
    },
  ];
  const row = new Map([["svc-convex", { serviceId: "svc-convex", containerId: "c-convex" }]]);

  it("dials the container port BEHIND the matched publish, not the first one", () => {
    expect(pickProjectPortOwner({ port: 9090, services: multi, rowByService: row })).toEqual({
      serviceId: "svc-convex",
      serviceName: "convex",
      containerPort: 4000,
      via: "published-port",
    });
  });

  it("still resolves the first mapping correctly", () => {
    expect(pickProjectPortOwner({ port: 8080, services: multi, rowByService: row })).toMatchObject({
      containerPort: 3000,
      via: "published-port",
    });
  });

  it("dials a container port directly when the service listens on it", () => {
    expect(pickProjectPortOwner({ port: 4000, services: multi, rowByService: row })).toMatchObject({
      containerPort: 4000,
      via: "container-port",
    });
  });

  it("reads the container side first WITHIN one service when the number is on both", () => {
    // "3000:9000" publishes 3000 → 9000, while "3000" also listens on 3000. A port the
    // service actually listens on is dialed directly rather than followed as a mapping.
    const both = [
      { id: "svc-x", name: "x", enabled: true, exposed: false, ports: ["3000:9000", "3000"] },
    ];
    expect(
      pickProjectPortOwner({
        port: 3000,
        services: both,
        rowByService: new Map([["svc-x", { serviceId: "svc-x", containerId: "c-x" }]]),
      }),
    ).toMatchObject({ containerPort: 3000, via: "container-port" });
  });
});

describe("describeCandidatePorts", () => {
  it("lists each candidate service's ports for the unmatched-port log line", () => {
    expect(describeCandidatePorts({ services, rowByService: rows })).toBe(
      "postgres=5432, web=3000, worker=none",
    );
  });

  it("says so when nothing has a container", () => {
    expect(describeCandidatePorts({ services, rowByService: new Map() })).toBe(
      "no service with a container",
    );
  });
});

/**
 * The deploy path and the live re-apply resolve the SAME project-level route through
 * two entry points — `buildProjectServiceUpstream` (pure, from the facts a deploy just
 * recorded) and `resolveProjectServiceUpstream` (live, from a daemon read). Two entry
 * points is how #618's class started: the compose deploy and the live edit answered
 * "which upstream does this hostname proxy to" differently, so a route worked after a
 * domain save and was absent from the deploy's own account of itself.
 *
 * They share `pickProjectPortOwner`, so given the same facts they must agree exactly —
 * with ONE deliberate asymmetry, covered by its own suite below: a service declaring
 * several container ports has no attributable host port, and the DEPLOY entry point
 * refuses to guess one where the live read (first-binding) still returns something. The
 * deploy is stricter there on purpose; agreement is asserted over the attributable
 * shapes, which is every single-port service.
 */
describe("deploy and live upstream resolution agree", () => {
  /** Reports precisely what the deploy's own result rows carry. */
  const agreeingRuntime = (ip: string | null, hostPort?: number) => ({
    name: "docker" as const,
    supports: (cap: string) => cap === "containerIp" || cap === "containerInfo",
    getContainerIp: async () => ip,
    getContainerInfo: async () => ({ containerId: "c", status: "running", ip, hostPort }) as never,
  });

  const cases: Array<{ label: string; strategy: "loopback-port" | "container-ip"; port: number }> =
    [
      { label: "container-port match, loopback", strategy: "loopback-port", port: 3000 },
      { label: "container-port match, container-ip", strategy: "container-ip", port: 3000 },
      { label: "published-port match, loopback", strategy: "loopback-port", port: 8080 },
      { label: "published-port match, container-ip", strategy: "container-ip", port: 8080 },
      { label: "no match at all", strategy: "loopback-port", port: 9999 },
    ];

  const mapped = [
    { id: "svc-postgres", name: "postgres", enabled: true, exposed: false, ports: ["5432"] },
    { id: "svc-web", name: "web", enabled: true, exposed: false, ports: ["8080:3000"] },
  ];
  const mappedRows = new Map([
    ["svc-postgres", { serviceId: "svc-postgres", containerId: "c-postgres", ip: "10.0.0.3" }],
    ["svc-web", { serviceId: "svc-web", containerId: "c-web", ip: "10.0.0.2", hostPort: 8080 }],
  ]);

  for (const { label, strategy, port } of cases) {
    it(`agrees — ${label}`, async () => {
      const built = buildProjectServiceUpstream({
        strategy,
        port,
        services: mapped,
        rowByService: mappedRows,
      });
      const resolved = await resolveProjectServiceUpstream({
        strategy,
        runtime: agreeingRuntime("10.0.0.2", 8080),
        port,
        services: mapped,
        rowByService: mappedRows,
      });
      expect(built?.url ?? null).toBe(resolved?.url ?? null);
      expect(built?.owner ?? null).toEqual(resolved?.owner ?? null);
    });
  }
});

describe("buildProjectServiceUpstream", () => {
  it("uses the deploy's recorded publish rather than asking the daemon", () => {
    // No runtime argument exists on this entry point at all — that is the point: the
    // containers were just created and this ip/hostPort is what is about to be
    // persisted, so a second read could only disagree with it.
    expect(
      buildProjectServiceUpstream({
        strategy: "loopback-port",
        port: 3000,
        services,
        rowByService: rows,
      })?.url,
    ).toBe("http://127.0.0.1:3000");
  });

  it("dials the container IP when the deploy recorded no publish", () => {
    expect(
      buildProjectServiceUpstream({
        strategy: "container-ip",
        port: 5432,
        services,
        rowByService: rows,
      }),
    ).toMatchObject({ url: "http://10.0.0.3:5432" });
  });

  it("is null when no service offers the port", () => {
    expect(
      buildProjectServiceUpstream({
        strategy: "loopback-port",
        port: 9999,
        services,
        rowByService: rows,
      }),
    ).toBeNull();
  });
});

describe("buildProjectServiceUpstream host-port attribution", () => {
  /**
   * A `service_deployment` row carries ONE scalar hostPort, and on the deploy path it is
   * the PRIMARY routed port's pin — the deploy pins only the ports its own service
   * routes use, so a project-level route's port can have no pin at all. Applying the
   * scalar to a container port it does not belong to dials a DIFFERENT app on the box.
   */
  const multi = [
    {
      id: "svc-minio",
      name: "minio",
      enabled: true,
      exposed: true,
      ports: ["9000", "9001"],
    },
  ];
  // 32001 is 9000's pin (the primary routed port). 9001 has none.
  const multiRows = new Map([
    [
      "svc-minio",
      { serviceId: "svc-minio", containerId: "c-minio", ip: "10.0.0.7", hostPort: 32001 },
    ],
  ]);

  it("does NOT dial another port's pin for a multi-port service", () => {
    const built = buildProjectServiceUpstream({
      strategy: "loopback-port",
      port: 9001,
      services: multi,
      rowByService: multiRows,
    });
    expect(built?.url).not.toBe("http://127.0.0.1:32001");
    // Correct rather than merely lucky: the container IP at the port that was matched.
    expect(built?.url).toBe("http://10.0.0.7:9001");
  });

  it("still uses the pin when the service declares only ONE container port", () => {
    // Unambiguous: a single-port service can only have pinned that port, which is the
    // overwhelmingly common shape (and the #618 reporter's).
    const single = [{ id: "svc-web", name: "web", enabled: true, exposed: true, ports: ["3000"] }];
    expect(
      buildProjectServiceUpstream({
        strategy: "loopback-port",
        port: 3000,
        services: single,
        rowByService: new Map([
          [
            "svc-web",
            { serviceId: "svc-web", containerId: "c-web", ip: "10.0.0.2", hostPort: 32770 },
          ],
        ]),
      })?.url,
    ).toBe("http://127.0.0.1:32770");
  });

  it("is unaffected under container-ip, which never dials a host port", () => {
    expect(
      buildProjectServiceUpstream({
        strategy: "container-ip",
        port: 9001,
        services: multi,
        rowByService: multiRows,
      })?.url,
    ).toBe("http://10.0.0.7:9001");
  });
});

describe("buildProjectServiceUpstream with a per-port host-port map", () => {
  /**
   * The exact answer, once the caller has one. A deploy holds the runtime's report of
   * every binding UNIONED with the pins it just published and persists that map, so
   * deploy-time and later route re-applies make the same per-port decision.
   */
  const multi = [
    { id: "svc-minio", name: "minio", enabled: true, exposed: true, ports: ["9000", "9001"] },
  ];

  it("dials the publish belonging to the resolved container port", () => {
    expect(
      buildProjectServiceUpstream({
        strategy: "loopback-port",
        port: 9001,
        services: multi,
        rowByService: new Map([
          [
            "svc-minio",
            {
              serviceId: "svc-minio",
              containerId: "c-minio",
              ip: "10.0.0.7",
              hostPort: 34100, // 9000's pin — the scalar, and the wrong answer for 9001
              hostPortByContainerPort: { 9000: 34100, 9001: 34101 },
            },
          ],
        ]),
      })?.url,
    ).toBe("http://127.0.0.1:34101");
  });

  it("uses the durable service-deployment map after the deploy result is gone", () => {
    expect(
      buildProjectServiceUpstream({
        strategy: "loopback-port",
        port: 9001,
        services: multi,
        rowByService: new Map([
          [
            "svc-minio",
            {
              serviceId: "svc-minio",
              containerId: "c-minio",
              ip: "10.0.0.7",
              hostPort: 34100,
              hostPorts: { "9000": 34100, "9001": 34101 },
            },
          ],
        ]),
      })?.url,
    ).toBe("http://127.0.0.1:34101");
  });

  it("treats a map with no entry for the port as 'not published', not 'use a sibling'", () => {
    expect(
      buildProjectServiceUpstream({
        strategy: "loopback-port",
        port: 9000,
        services: multi,
        rowByService: new Map([
          [
            "svc-minio",
            {
              serviceId: "svc-minio",
              containerId: "c-minio",
              ip: "10.0.0.7",
              hostPort: 34101,
              hostPortByContainerPort: { 9001: 34101 },
            },
          ],
        ]),
      })?.url,
    ).toBe("http://10.0.0.7:9000");
  });
});
