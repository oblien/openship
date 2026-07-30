import { describe, expect, it } from "vitest";
import { projectSwarmStackSource } from "./swarm-stack-projection";

describe("Swarm stack source projection", () => {
  it("derives Swarm deployment fields from ordered source files without changing their source text", () => {
    const files = [
      {
        path: "compose.yaml",
        content: `x-preserve: &shared
  tracing: enabled
services:
  api:
    image: registry.example/api:1
    labels:
      app: api
    ports:
      - target: 8080
        published: 443
        protocol: tcp
        mode: host
    volumes: [data:/var/lib/api]
    networks: [frontend]
    configs: [app-config]
    secrets:
      - source: db-password
    deploy:
      mode: replicated
      replicas: 2
      endpoint_mode: dnsrr
      labels:
        deploy-label: present
      placement:
        constraints: [node.labels.zone == west]
      resources:
        limits: { cpus: "0.5", memory: 256M }
      update_config: { parallelism: 1 }
      rollback_config: { parallelism: 1 }
      restart_policy: { condition: on-failure }
volumes: { data: {} }
networks: { frontend: { external: true } }
configs: { app-config: { file: ./config.yml } }
secrets: { db-password: { external: true } }
`,
      },
      {
        path: "deploy/production.yaml",
        content: `services:
  api:
    image: registry.example/api:2
`,
      },
    ];

    const projection = projectSwarmStackSource(files);
    expect(projection.services).toHaveLength(1);
    expect(projection.services[0]).toMatchObject({
      sourceServiceName: "api",
      image: "registry.example/api:2",
      mode: "replicated",
      replicas: { desired: 2 },
      endpointMode: "dnsrr",
      placement: { constraints: ["node.labels.zone == west"] },
      resources: { limits: { cpus: "0.5", memory: "256M" } },
      labels: { app: "api", "deploy-label": "present" },
      publishedPorts: [{ target: 8080, published: 443, protocol: "tcp", mode: "host" }],
      volumes: ["data:/var/lib/api"],
      networks: ["frontend"],
      configs: ["app-config"],
      secrets: ["db-password"],
    });
    expect(projection).toMatchObject({
      networks: ["frontend"], volumes: ["data"], configs: ["app-config"], secrets: ["db-password"],
    });
    expect(files[0]?.content).toContain("x-preserve");
  });

  it("reports Compose settings that do not carry into Swarm as expected", () => {
    const projection = projectSwarmStackSource([{ path: "compose.yaml", content: `services:
  worker:
    build: .
    container_name: fixed-worker
    restart: always
    depends_on:
      db: { condition: service_healthy }
    links: [db]
    deploy: { mode: replicated-job }
` }]);
    expect(projection.compatibility.map((issue) => issue.code)).toEqual([
      "SWARM_BUILD_REQUIRES_REGISTRY",
      "SWARM_CONTAINER_NAME_IGNORED",
      "SWARM_RESTART_IGNORED",
      "SWARM_DEPENDS_ON_CONDITIONS",
      "SWARM_LINKS_IGNORED",
      "SWARM_JOB_MODE_ENGINE_SUPPORT",
    ]);
  });
});
