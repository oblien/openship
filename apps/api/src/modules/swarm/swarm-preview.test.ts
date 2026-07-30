import { describe, expect, it } from "vitest";
import type { SwarmServiceState } from "@repo/adapters";
import { previewSwarmStack, redactRenderWarnings, redactRenderedStackYaml } from "./swarm-preview";

function live(overrides: Partial<SwarmServiceState> = {}): SwarmServiceState {
  return {
    id: "svc-web", name: "blog_web", sourceServiceName: "web", stackName: "blog", specVersion: 1,
    mode: "replicated", desiredReplicas: 1, image: "registry.example/web:old", labels: {}, endpointMode: null,
    placement: null, resources: null, updateConfig: null, rollbackConfig: null, restartPolicy: null,
    networks: [], configs: [], secrets: [], publishedPorts: [], updateState: null, updateMessage: null,
    ...overrides,
  };
}

describe("Swarm stack preview", () => {
  it("structurally redacts secret canaries while retaining safe secret/config references", () => {
    const yaml = `services:
  web:
    image: nginx
    environment:
      DB_PASSWORD: canary-db-password
      SAFE: okay
    labels:
      api_token: canary-label-token
secrets:
  db-password:
    data: canary-secret-data
configs:
  app-config:
    content: canary-config-content
x-private-key: |-
  -----BEGIN PRIVATE KEY-----
  canary-private-key
`;
    const redacted = redactRenderedStackYaml(yaml);
    expect(redacted).toContain("db-password");
    expect(redacted).toContain("app-config");
    for (const canary of ["canary-db-password", "canary-label-token", "canary-secret-data", "canary-config-content", "canary-private-key"]) {
      expect(redacted).not.toContain(canary);
    }
    expect(redactRenderWarnings(["token=canary-warning-token"], { TOKEN: "canary-warning-token" })[0]).not.toContain("canary-warning-token");
  });

  it("classifies service changes without dumping environment material", () => {
    const preview = previewSwarmStack({
      renderedYaml: `services:
  web:
    image: registry.example/web:new
    ports: [{ target: 8080, published: 443, mode: host }]
    networks: [frontend]
    configs: [app-config]
    secrets: [db-password]
    deploy:
      replicas: 2
      placement: { constraints: [node.labels.zone == west] }
      resources: { limits: { memory: 256M } }
      labels: { traefik.enable: "true" }
`,
      renderedDigest: "sha256:rendered",
      sourceDigest: "sha256:source",
      liveServices: [
        live({
          image: "registry.example/web:old",
          desiredReplicas: 1,
          networks: ["old-network"],
          configs: ["old-config"],
          secrets: ["old-secret"],
          publishedPorts: [{ target: 80, published: 80, protocol: "tcp", mode: "ingress" }],
          labels: { "traefik.enable": "false" },
        }),
        live({ id: "svc-old", sourceServiceName: "old", name: "blog_old" }),
      ],
    });
    expect(preview.changes.map((change) => change.kind)).toEqual(expect.arrayContaining([
      "image-change",
      "replica-mode-change",
      "placement-resource-change",
      "network-port-change",
      "config-secret-reference-change",
      "labels-routing-change",
      "service-remove",
    ]));
    expect(JSON.stringify(preview)).not.toContain("canary");
  });

  it("recognizes a no-op only when desired and observed digests are both unchanged", () => {
    const input = {
      renderedYaml: "services:\n  web:\n    image: nginx:alpine\n    deploy: { replicas: 1 }\n",
      renderedDigest: "sha256:rendered",
      sourceDigest: "sha256:source",
      liveServices: [live({ image: "nginx:alpine" })],
    };
    const first = previewSwarmStack(input);
    const second = previewSwarmStack({
      ...input,
      lastAppliedRenderedDigest: first.renderedDigest,
      lastObservedLiveDigest: first.liveStateDigest,
    });
    expect(second.changes).toEqual([]);
    expect(second.noOp).toBe(true);
  });
});
