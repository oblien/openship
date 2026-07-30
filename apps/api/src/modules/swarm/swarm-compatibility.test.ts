import { describe, expect, it } from "vitest";
import { evaluateSwarmCompatibility } from "./swarm-compatibility";

describe("Swarm compatibility preflight", () => {
  it("blocks missing external resources and source builds without a registry", () => {
    const report = evaluateSwarmCompatibility({
      renderedYaml: `services:
  database:
    build: .
    volumes: [db-data:/var/lib/postgresql/data]
    logging: { driver: fluentd }
networks:
  ingress:
    external: true
volumes:
  db-data: {}
configs:
  app-config:
    external: true
secrets:
  db-password:
    external: true
`,
      discovery: { networks: [], volumes: [], configs: [], secrets: [] },
      registryConfigured: false,
    });
    expect(report.blockers.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "SWARM_BUILD_REGISTRY_REQUIRED",
      "SWARM_EXTERNAL_NETWORK_MISSING",
      "SWARM_EXTERNAL_CONFIG_MISSING",
      "SWARM_EXTERNAL_SECRET_MISSING",
    ]));
    expect(report.warnings.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "SWARM_STORAGE_LOCAL_VOLUME_UNPINNED",
      "SWARM_SERVICE_LOGS_LIMITED",
    ]));
    expect([...report.blockers, ...report.warnings].every((issue) => issue.remediation.length > 0)).toBe(true);
  });

  it("names the services consuming a missing external config or secret", () => {
    const report = evaluateSwarmCompatibility({
      renderedYaml: `services:
  web:
    image: nginx
    configs: [shared-config]
  worker:
    image: busybox
    secrets: [shared-secret]
configs:
  shared-config: { external: true, name: external-config }
secrets:
  shared-secret: { external: true, name: external-secret }
`,
      discovery: { networks: [], volumes: [], configs: [], secrets: [] },
      registryConfigured: true,
    });
    expect(report.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "SWARM_EXTERNAL_CONFIG_MISSING", serviceName: "web", message: expect.stringContaining("Consumed by web") }),
      expect.objectContaining({ code: "SWARM_EXTERNAL_SECRET_MISSING", serviceName: "worker", message: expect.stringContaining("Consumed by worker") }),
    ]));
  });

  it("recognizes a single-node placement constraint but still describes local storage as non-portable", () => {
    const report = evaluateSwarmCompatibility({
      renderedYaml: `services:
  database:
    image: postgres:16
    volumes: [db-data:/var/lib/postgresql/data]
    deploy:
      placement:
        constraints: [node.labels.database == true]
networks:
  ingress:
    external: { name: shared-ingress }
volumes:
  db-data: { external: true }
configs:
  app-config: { external: true, name: shared-app-config }
secrets:
  db-password: { external: true, name: shared-db-password }
`,
      discovery: {
        nodes: [{ id: "node-db", hostname: "db-1", status: "ready", availability: "active", managerStatus: null, engineVersion: "27", labels: { database: "true" } }],
        networks: [{ id: "n1", name: "shared-ingress", driver: "overlay", scope: "swarm", labels: {} }],
        volumes: [{ name: "db-data", driver: "local", scope: "local", labels: {}, options: {} }],
        configs: [{ id: "c1", name: "shared-app-config", labels: {}, createdAt: null }],
        secrets: [{ id: "s1", name: "shared-db-password", labels: {}, createdAt: null }],
      },
      registryConfigured: true,
    });
    expect(report.blockers).toEqual([]);
    expect(report.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "SWARM_STORAGE_LOCAL_VOLUME_PINNED", serviceName: "database" }),
    ]));
  });

  it("classifies bind, tmpfs, shared, and unknown-volume storage without claiming high availability", () => {
    const report = evaluateSwarmCompatibility({
      renderedYaml: `services:
  app:
    image: nginx
    volumes:
      - /srv/app:/app
      - type: tmpfs
        target: /run/cache
      - nfs-data:/data
      - mystery:/mystery
volumes:
  nfs-data:
    driver: local
    driver_opts: { type: nfs, device: ":/exports/app" }
  mystery: { driver: custom-driver }
`,
      discovery: { networks: [], volumes: [], configs: [], secrets: [] },
      registryConfigured: true,
    });
    expect(report.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "SWARM_STORAGE_BIND_UNVERIFIED", acknowledgementKey: "app:bind:/srv/app", message: expect.stringContaining("High storage risk") }),
      expect.objectContaining({ code: "SWARM_STORAGE_TMPFS_EPHEMERAL" }),
      expect.objectContaining({ code: "SWARM_STORAGE_SHARED_VOLUME", message: expect.stringContaining("does not verify") }),
      expect.objectContaining({ code: "SWARM_STORAGE_VOLUME_DRIVER_UNKNOWN" }),
    ]));
  });

  it("suppresses only the operator-acknowledged storage finding", () => {
    const renderedYaml = `services:
  database:
    image: postgres:16
    volumes: [db-data:/var/lib/postgresql/data]
volumes: { db-data: {} }
`;
    const report = evaluateSwarmCompatibility({
      renderedYaml,
      discovery: { networks: [], volumes: [], configs: [], secrets: [] },
      registryConfigured: true,
      acknowledgedStorage: ["database:volume:db-data"],
    });
    expect(report.warnings.map((issue) => issue.code)).not.toContain("SWARM_STORAGE_LOCAL_VOLUME_UNPINNED");
  });
});
