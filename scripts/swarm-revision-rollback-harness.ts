/** Proves the retained rendered YAML restores Swarm image + replica intent. */

import { createHash } from "node:crypto";
import { LocalExecutor, SwarmRuntime } from "@repo/adapters";

const stackName = "openship-swarm-rollback-proof";
const serviceName = `${stackName}_web`;
const v1 = `services:
  web:
    image: nginx:1.27-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10
    deploy:
      replicas: 2
`;
const v2 = `services:
  web:
    image: httpd:2.4-alpine@sha256:1b766f17b84026429b7cb243317b142921b24432336e798bc881c43f45ed9567
    deploy:
      replicas: 1
`;

const runtime = await SwarmRuntime.create({ executor: new LocalExecutor(), timeoutMs: 60_000 });

async function apply(renderedYaml: string): Promise<void> {
  await runtime.deployStack({ stackName, renderedYaml, prune: true, resolveImage: "always" });
  for (let attempt = 0; attempt < 45; attempt++) {
    const service = (await runtime.discover()).services.find((candidate) => candidate.name === serviceName);
    if (service?.desiredReplicas === (renderedYaml === v1 ? 2 : 1)) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Swarm did not report ${serviceName} after stack apply.`);
}

await apply(v1);
const retained = { yaml: v1, digest: `sha256:${createHash("sha256").update(v1).digest("hex")}` };
await apply(v2);
await apply(retained.yaml);

const final = (await runtime.discover()).services.find((candidate) => candidate.name === serviceName);
if (!final || final.desiredReplicas !== 2 || final.image !== "nginx:1.27-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10") {
  throw new Error(`Retained revision did not restore the exact image/replica intent: ${JSON.stringify(final)}`);
}
console.log(JSON.stringify({ result: "swarm retained revision rollback proof completed", stackName, replicas: final.desiredReplicas, image: final.image, retainedDigest: retained.digest }));
