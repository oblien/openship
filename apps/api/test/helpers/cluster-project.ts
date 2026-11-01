import { db, schema, repos, seedServer, type SeededOwner } from "../modules/jobs/_harness";
import { clusterRuntimePlanFixture } from "../../../../packages/contracts/test/cluster-runtime-fixtures";

export async function seedClusterProject(owner: SeededOwner) {
  const plan = clusterRuntimePlanFixture();
  for (const host of plan.hosts) {
    host.serverId = await seedServer(owner.orgId, host.name);
    host.ready = true;
    host.installed = true;
    for (const step of host.steps) step.status = "completed";
  }
  const network = await repos.serverCluster.create(
    owner.orgId,
    {
      name: "Private network",
      network: { mode: "native", cidrs: ["10.20.0.0/24"], mtu: 1400, probePort: 51821 },
      members: plan.hosts.map((host) => ({
        serverId: host.serverId,
        privateIp: host.privateIp,
        providerId: "custom" as const,
      })),
    },
    crypto.randomUUID(),
    "network",
  );
  const cluster = await repos.computeCluster.create(
    owner.orgId,
    { name: "Pool", networkId: network.id, serverIds: plan.hosts.map((host) => host.serverId) },
    crypto.randomUUID(),
    "cluster",
  );
  plan.networkId = network.id;
  plan.clusterUid = "test-kubernetes-uid";
  const { row } = await repos.clusterRuntime.start(
    owner.orgId,
    cluster.id,
    cluster.revision,
    crypto.randomUUID(),
    plan,
  );
  await repos.clusterRuntime.finish(row.id, row.generation, plan, "setup", null);
  const id = crypto.randomUUID(),
    groupId = crypto.randomUUID();
  await db
    .insert(schema.projectGroup)
    .values({ id: groupId, organizationId: owner.orgId, name: "API", slug: id });
  await db.insert(schema.project).values({
    id,
    groupId,
    organizationId: owner.orgId,
    name: "API",
    slug: id,
    clusterId: cluster.id,
    clusterConfig: { replicas: 1 },
  });
  return {
    id,
    clusterId: cluster.id,
    runtime: (await repos.clusterRuntime.get(owner.orgId, cluster.id))!,
    plan,
  };
}
