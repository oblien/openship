import { describe, expect, it } from "vitest";
import type { DiscoveredGroup, DiscoveredService } from "@/lib/api/server-migration";
import { discoveryGraph, selectableServices, selectedGroupKey } from "./discovery-model";

const service = (
  name: string,
  containerId: string,
  rest: Partial<DiscoveredService> = {},
): DiscoveredService => ({
  name,
  containerId,
  source: "compose",
  running: true,
  image: "example:latest",
  ports: [],
  env: {},
  volumes: [],
  networks: [],
  dependsOn: [],
  warnings: [],
  ...rest,
});

describe("import discovery topology", () => {
  it("keeps same-named services and their dependencies scoped to each Compose project", () => {
    const a = discoveryGraph(
      {
        project: "shop",
        services: [
          service("web", "shop-web", { dependsOn: ["postgres"] }),
          service("postgres", "shop-db"),
        ],
      },
      "Depends on",
    );
    const b = discoveryGraph(
      {
        project: "mail",
        services: [
          service("web", "mail-web", { dependsOn: ["postgres"] }),
          service("postgres", "mail-db"),
        ],
      },
      "Depends on",
    );
    expect(a.edges).toMatchObject([{ source: "shop-web", target: "shop-db", kind: "dependency" }]);
    expect(b.edges).toMatchObject([{ source: "mail-web", target: "mail-db", kind: "dependency" }]);
    expect(new Set([...a.nodes, ...b.nodes].map((node) => node.id)).size).toBe(4);
  });

  it("does not invent missing dependencies or infer traffic from a shared Docker network", () => {
    const graph = discoveryGraph(
      {
        project: "shop",
        services: [
          service("web", "web", { dependsOn: ["unknown", "web"], networks: ["shared"] }),
          service("redis", "redis", { networks: ["shared"] }),
        ],
      },
      "Depends on",
    );
    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toEqual([]);
  });

  it("resolves discovered container aliases, deduplicates edges and retains cyclic observations", () => {
    const graph = discoveryGraph(
      {
        project: "shop",
        services: [
          service("web", "web-id", { dependsOn: ["database", "shop-database-1", "db-id"] }),
          service("database", "db-id", { containerName: "/shop-database-1", dependsOn: ["web"] }),
        ],
      },
      "Depends on",
    );
    expect(graph.edges).toMatchObject([
      { source: "web-id", target: "db-id" },
      { source: "db-id", target: "web-id" },
    ]);
  });

  it("keeps discovered environment values and host paths out of the visual graph", () => {
    const graph = discoveryGraph(
      {
        project: "shop",
        services: [
          service("db", "db-id", {
            env: { PASSWORD: "private-env" },
            envImageDefaults: { TOKEN: "private-default" },
            volumes: [{ source: "/private-host-path", target: "/data", type: "bind", rw: true }],
          }),
        ],
      },
      "Depends on",
    );
    for (const privateValue of ["private-env", "private-default", "private-host-path"])
      expect(JSON.stringify(graph)).not.toContain(privateValue);
  });

  it("select-all excludes proxies, unbuilt services and containers assigned to another import", () => {
    const group: DiscoveredGroup = {
      project: "shop",
      services: [
        service("web", "web"),
        service("db", "db"),
        service("worker", "worker", { image: undefined, build: "." }),
        service("proxy", "proxy", { proxyKind: "traefik" }),
      ],
    };
    expect(
      selectableServices(group, "first", new Map([["db", "second"]])).map(
        (service) => service.containerId,
      ),
    ).toEqual(["web"]);
  });

  it("tracks the remaining group for automatic naming after a selected project is removed", () => {
    const groups = [
      { project: "shop", services: [service("db", "shop-db")] },
      { project: "mail", services: [service("db", "mail-db")] },
    ];
    expect(selectedGroupKey(groups, new Set(["shop-db", "mail-db"]), "mail")).toBe("mail");
    expect(selectedGroupKey(groups, new Set(["mail-db"]), "shop")).toBe("mail");
    expect(selectedGroupKey(groups, new Set(), "shop")).toBeNull();
  });
});
