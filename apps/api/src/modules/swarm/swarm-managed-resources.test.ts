import { describe, expect, it, vi } from "vitest";
import {
  bindManagedSwarmResources,
  ensureManagedSwarmResources,
  planManagedSwarmResources,
  referencedSwarmResourceRefs,
  versionedSwarmResourceName,
} from "./swarm-managed-resources";

const files = [
  {
    path: "compose.yaml",
    content: `services:
  web:
    image: nginx:1.27-alpine
    configs:
      - source: app-config
        target: /etc/app/config.yaml
    secrets:
      - source: db-password
        target: db-password
configs:
  app-config:
    file: config/app.yaml
secrets:
  db-password:
    file: secrets/db-password
  operator-managed:
    external: true
`,
  },
  { path: "config/app.yaml", content: "colour: blue\n" },
  { path: "secrets/db-password", content: "correct-horse-battery-staple\n" },
];

describe("managed Swarm resources", () => {
  it("versions source-backed config and secret files while preserving service logical mount sources", () => {
    const resources = planManagedSwarmResources({ projectId: "project-blog", files, composePaths: ["compose.yaml"] });
    expect(resources.map((resource) => [resource.kind, resource.logicalName])).toEqual([
      ["config", "app-config"],
      ["secret", "db-password"],
    ]);
    expect(resources[0]?.resourceName).toMatch(/^openship_project-blog_app-config_[a-f0-9]{16}$/);
    const bound = bindManagedSwarmResources(files[0]!.content, resources);
    expect(bound).toContain("source: app-config");
    expect(bound).toContain("target: /etc/app/config.yaml");
    expect(bound).toContain(`name: ${resources[0]!.resourceName}`);
    expect(bound).toContain(`name: ${resources[1]!.resourceName}`);
    expect(bound).not.toContain("correct-horse-battery-staple");
    expect(referencedSwarmResourceRefs(bound)).toEqual({
      configs: [resources[0]!.resourceName],
      secrets: [resources[1]!.resourceName, "operator-managed"],
    });
    expect(referencedSwarmResourceRefs(`configs:
  logical-config: { external: true, name: shared-config }
secrets:
  logical-secret: { external: true, name: shared-secret }
`)).toEqual({
      configs: ["shared-config"],
      secrets: ["shared-secret"],
    });
  });

  it("uses deterministic bounded version names", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    expect(versionedSwarmResourceName("project-blog", "app-config", digest)).toBe("openship_project-blog_app-config_aaaaaaaaaaaaaaaa");
    expect(versionedSwarmResourceName("project", "x".repeat(200), digest)).toHaveLength(64);
    expect(versionedSwarmResourceName("project", `x${"a".repeat(199)}`, digest))
      .not.toBe(versionedSwarmResourceName("project", `x${"b".repeat(199)}`, digest));
  });

  it("creates only missing metadata-matched resources and never inspects secret payloads", async () => {
    const resources = planManagedSwarmResources({ projectId: "project-blog", files, composePaths: ["compose.yaml"] });
    const exec = vi.fn(async (command: string) => command.startsWith("umask 077") ? "/tmp/openship-swarm-resource.abc123" : "");
    const writeFile = vi.fn(async () => undefined);
    const result = await ensureManagedSwarmResources({
      executor: { exec, writeFile, rm: vi.fn(async () => undefined) },
      discovery: { configs: [], secrets: [] },
      projectId: "project-blog",
      resources,
    });
    expect(result.configs).toEqual([resources[0]!.resourceName]);
    expect(result.secrets).toEqual([resources[1]!.resourceName]);
    const commands = exec.mock.calls.map(([command]) => command).join("\n");
    expect(commands).toContain("docker config create");
    expect(commands).toContain("docker secret create");
    expect(commands).not.toContain("inspect");
    expect(commands).not.toContain("correct-horse-battery-staple");
  });

  it("refuses a colliding immutable name before writing any source payload", async () => {
    const resources = planManagedSwarmResources({ projectId: "project-blog", files, composePaths: ["compose.yaml"] });
    const exec = vi.fn(async () => "");
    const writeFile = vi.fn(async () => undefined);
    await expect(ensureManagedSwarmResources({
      executor: { exec, writeFile, rm: vi.fn(async () => undefined) },
      discovery: { configs: [{ id: "config-1", name: resources[0]!.resourceName, labels: {}, createdAt: null }], secrets: [] },
      projectId: "project-blog",
      resources,
    })).rejects.toMatchObject({ code: "SWARM_MANAGED_RESOURCE_CONFLICT" });
    expect(writeFile).not.toHaveBeenCalled();
  });
});
