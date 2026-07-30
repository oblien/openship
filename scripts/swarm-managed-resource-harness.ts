/** Proves immutable source-backed config/secret versions update and roll back on a disposable Swarm. */

import { LocalExecutor, SwarmRuntime } from "@repo/adapters";
import {
  bindManagedSwarmResources,
  ensureManagedSwarmResources,
  planManagedSwarmResources,
} from "../apps/api/src/modules/swarm/swarm-managed-resources";

const stackName = "openship-swarm-resource-proof";
const projectId = "openship-resource-proof";
const serviceName = `${stackName}_web`;
const executor = new LocalExecutor();
const runtime = await SwarmRuntime.create({ executor, timeoutMs: 60_000 });

function source(config: string, secret: string) {
  return [
    {
      path: "compose.yaml",
      content: `services:
  web:
    image: nginx:1.27-alpine
    deploy:
      replicas: 1
    configs:
      - source: app-config
        target: /usr/share/nginx/html/config.txt
    secrets:
      - source: app-secret
        target: app-secret
configs:
  app-config:
    file: config/app.txt
secrets:
  app-secret:
    file: secrets/app-secret
`,
    },
    { path: "config/app.txt", content: config },
    { path: "secrets/app-secret", content: secret },
  ];
}

async function renderAndPrepare(files: ReturnType<typeof source>) {
  const resources = planManagedSwarmResources({ projectId, files, composePaths: ["compose.yaml"] });
  const rendered = await runtime.renderStack({ files, composePaths: ["compose.yaml"] });
  const discovery = await runtime.discover();
  await ensureManagedSwarmResources({ executor, discovery, projectId, resources });
  return {
    resources,
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

const first = await renderAndPrepare(source("version=one\n", "first-secret-value\n"));
await apply(first.renderedYaml, {
  configs: first.resources.filter((resource) => resource.kind === "config").map((resource) => resource.resourceName),
  secrets: first.resources.filter((resource) => resource.kind === "secret").map((resource) => resource.resourceName),
});

const second = await renderAndPrepare(source("version=two\n", "second-secret-value\n"));
await apply(second.renderedYaml, {
  configs: second.resources.filter((resource) => resource.kind === "config").map((resource) => resource.resourceName),
  secrets: second.resources.filter((resource) => resource.kind === "secret").map((resource) => resource.resourceName),
});

// Reapplying the retained first rendered document must attach the prior exact
// resource versions. This uses discovery metadata only and never inspects a
// secret payload.
await apply(first.renderedYaml, {
  configs: first.resources.filter((resource) => resource.kind === "config").map((resource) => resource.resourceName),
  secrets: first.resources.filter((resource) => resource.kind === "secret").map((resource) => resource.resourceName),
});

console.log(JSON.stringify({
  result: "swarm managed resource version and rollback proof completed",
  stackName,
  first: first.resources.map(({ kind, logicalName, resourceName, contentDigest }) => ({ kind, logicalName, resourceName, contentDigest })),
  second: second.resources.map(({ kind, logicalName, resourceName, contentDigest }) => ({ kind, logicalName, resourceName, contentDigest })),
}));
