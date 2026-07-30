/** Disposable proof that external Swarm volume/network identities survive stack lifecycle operations. */

import { LocalExecutor, SwarmRuntime } from "@repo/adapters";

const stackName = "openship-swarm-resource-identity-proof";
const volumeName = "openship-resource-identity-proof-data";
const networkName = "openship-resource-identity-proof-net";
const serviceName = `${stackName}_database`;
const executor = new LocalExecutor();
const runtime = await SwarmRuntime.create({ executor, timeoutMs: 60_000 });

async function command(value: string): Promise<void> {
  await executor.exec(value);
}

async function waitForService(): Promise<void> {
  for (let attempt = 0; attempt < 45; attempt++) {
    const service = (await runtime.discover()).services.find((candidate) => candidate.name === serviceName);
    if (service?.desiredReplicas === 1 && service.volumes?.includes(volumeName) && service.networks.includes(networkName)) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("The proof stack did not preserve the expected external volume/network references.");
}

await command(`docker volume create '${volumeName}' >/dev/null`);
await command(`docker network create --driver overlay --attachable '${networkName}' >/dev/null`);
await command(`docker run --rm -v '${volumeName}:/data' busybox:1.36 sh -c 'printf %s preserved > /data/marker' >/dev/null`);

const source = [{ path: "compose.yaml", content: `services:
  database:
    image: busybox:1.36
    command: ["sleep", "3600"]
    volumes:
      - source: database
        target: /data
        type: volume
    networks: [frontend]
volumes:
  database:
    external: true
    name: ${volumeName}
networks:
  frontend:
    external: true
    name: ${networkName}
` }];
const rendered = await runtime.renderStack({ files: source, composePaths: ["compose.yaml"] });

await runtime.deployStack({ stackName, renderedYaml: rendered.renderedYaml, prune: true, resolveImage: "always" });
await waitForService();
await runtime.deployStack({ stackName, renderedYaml: rendered.renderedYaml, prune: true, resolveImage: "always" });
await waitForService();
await runtime.removeStack({ stackName });

for (let attempt = 0; attempt < 30; attempt++) {
  if (!(await runtime.discover()).services.some((service) => service.stackName === stackName)) break;
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}
const marker = (await executor.exec(`docker run --rm -v '${volumeName}:/data:ro' busybox:1.36 cat /data/marker`)).trim();
if (marker !== "preserved") throw new Error("External volume data was not preserved after stack removal.");
await command(`docker volume inspect '${volumeName}' >/dev/null`);
await command(`docker network inspect '${networkName}' >/dev/null`);

console.log(JSON.stringify({ result: "external volume and network identity proof completed", stackName, volumeName, networkName }));
