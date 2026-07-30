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
      "SWARM_LOCAL_VOLUME_MOVABILITY",
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

  it("clears external prerequisites found on the manager and respects a stateful placement constraint", () => {
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
        networks: [{ id: "n1", name: "shared-ingress", driver: "overlay", scope: "swarm", labels: {} }],
        volumes: [{ name: "db-data", driver: "local", scope: "local", labels: {}, options: {} }],
        configs: [{ id: "c1", name: "shared-app-config", labels: {}, createdAt: null }],
        secrets: [{ id: "s1", name: "shared-db-password", labels: {}, createdAt: null }],
      },
      registryConfigured: true,
    });
    expect(report.blockers).toEqual([]);
    expect(report.warnings.map((issue) => issue.code)).not.toContain("SWARM_LOCAL_VOLUME_MOVABILITY");
  });
});
