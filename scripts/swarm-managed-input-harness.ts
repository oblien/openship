/**
 * Disposable manager proof for operator-entered Swarm config/secret inputs.
 * Payloads model the deployment-only decrypted values and are never emitted.
 */

import { LocalExecutor, SwarmRuntime } from "@repo/adapters";
import {
  bindManagedSwarmResources,
  ensureManagedSwarmResources,
  planManagedInputResources,
  removeNewManagedSwarmResources,
} from "../apps/api/src/modules/swarm/swarm-managed-resources";

const stackName = "openship-swarm-managed-input-proof";
const projectId = "openship-managed-input-proof";
const serviceName = `${stackName}_web`;
const executor = new LocalExecutor();
const runtime = await SwarmRuntime.create({ executor, timeoutMs: 60_000 });

const source = [{
  path: "compose.yaml",
  content: `services:
  web:
    image: nginx:1.27-alpine
    deploy:
      replicas: 1
    configs:
      - source: operator-config
        target: /usr/share/nginx/html/config.txt
    secrets:
      - source: operator-secret
        target: operator-secret
configs:
  operator-config: {}
secrets:
  operator-secret: {}
`,
}];

async function prepare(config: string, secret: string) {
  const resources = planManagedInputResources({
    projectId,
    inputs: [
      { kind: "config", logicalName: "operator-config", content: config },
      { kind: "secret", logicalName: "operator-secret", content: secret },
    ],
  });
  const rendered = await runtime.renderStack({ files: source, composePaths: ["compose.yaml"] });
  const ensured = await ensureManagedSwarmResources({
    executor,
    discovery: await runtime.discover(),
    projectId,
    resources,
  });
  return {
    resources,
    createdResources: ensured.createdResources,
    renderedYaml: bindManagedSwarmResources(rendered.renderedYaml, resources),
  };
}

async function apply(renderedYaml: string, expected: { configs: string[]; secrets: string[] }): Promise<void> {
  await runtime.deployStack({ stackName, renderedYaml, prune: true, resolveImage: "always" });
  for (let attempt = 0; attempt < 45; attempt++) {
    const service = (await runtime.discover()).services.find((candidate) => candidate.name === serviceName);
    if (
      service?.desiredReplicas === 1 &&
      expected.configs.every((name) => service.configs.includes(name)) &&
      expected.secrets.every((name) => service.secrets.includes(name))
    ) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Swarm did not attach the expected immutable resource references to ${serviceName}.`);
}

const first = await prepare("version=one\n", "first-managed-input");
await apply(first.renderedYaml, {
  configs: first.resources.filter((resource) => resource.kind === "config").map((resource) => resource.resourceName),
  secrets: first.resources.filter((resource) => resource.kind === "secret").map((resource) => resource.resourceName),
});

const second = await prepare("version=two\n", "second-managed-input");
await apply(second.renderedYaml, {
  configs: second.resources.filter((resource) => resource.kind === "config").map((resource) => resource.resourceName),
  secrets: second.resources.filter((resource) => resource.kind === "secret").map((resource) => resource.resourceName),
});

// Retained rendered YAML must roll back to the original exact versions.
await apply(first.renderedYaml, {
  configs: first.resources.filter((resource) => resource.kind === "config").map((resource) => resource.resourceName),
  secrets: first.resources.filter((resource) => resource.kind === "secret").map((resource) => resource.resourceName),
});

// Simulate a failure before stack apply. The just-created versions are safe to
// retire because no service can reference them yet; the retained v1 remains.
const abandoned = await prepare("version=abandoned\n", "abandoned-managed-input");
await removeNewManagedSwarmResources(executor, abandoned.createdResources);
const remainingNames = new Set([
  ...(await runtime.discover()).configs.map((resource) => resource.name),
  ...(await runtime.discover()).secrets.map((resource) => resource.name),
]);
if (abandoned.resources.some((resource) => remainingNames.has(resource.resourceName))) {
  throw new Error("Failed pre-apply resources were not retired.");
}

console.log(JSON.stringify({
  result: "managed Swarm input version, rollback, and pre-apply cleanup proof completed",
  stackName,
  first: first.resources.map(({ kind, logicalName, resourceName, contentDigest }) => ({ kind, logicalName, resourceName, contentDigest })),
  second: second.resources.map(({ kind, logicalName, resourceName, contentDigest }) => ({ kind, logicalName, resourceName, contentDigest })),
}));
