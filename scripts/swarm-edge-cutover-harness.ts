/** Runs the production reversible Swarm Edge cutover manager in the nested lab. */

import { LocalExecutor, SwarmEdgeCutoverManager, SwarmRuntime, SWARM_EDGE_SERVICE_NAME } from "@repo/adapters";

const routerName = process.env.OPENSHIP_SWARM_CUTOVER_ROUTER || "openship-swarm-cutover-router";
const runtime = await SwarmRuntime.create({ executor: new LocalExecutor(), timeoutMs: 60_000 });
const before = await runtime.discover();
const router = before.services.find((service) => service.name === routerName);
if (!router || router.specVersion === null || router.desiredReplicas === null) {
  throw new Error(`Disposable router ${routerName} is unavailable for cutover.`);
}
const cutover = new SwarmEdgeCutoverManager(runtime, new LocalExecutor());
const plan = await cutover.plan();
if (plan.kind !== "swarm-service" || plan.serviceId !== router.id || plan.replicas !== router.desiredReplicas) {
  throw new Error(`Unexpected cutover plan: ${JSON.stringify(plan)}`);
}
const result = await cutover.execute({ serviceId: plan.serviceId, specVersion: plan.specVersion });
const after = await runtime.discover();
const oldRouter = after.services.find((service) => service.id === router.id);
const edge = after.services.find((service) => service.name === SWARM_EDGE_SERVICE_NAME);
const edgeTasks = edge ? after.tasks.filter((task) => task.serviceId === edge.id && task.currentState.toLowerCase().startsWith("running")) : [];
if (!oldRouter || oldRouter.desiredReplicas !== 0 || oldRouter.publishedPorts.some((port) => port.published === 80 || port.published === 443)) {
  throw new Error("Cutover did not leave the legacy router scaled down with its edge publications removed.");
}
if (!edge || edgeTasks.length === 0) throw new Error("OpenShip Edge did not become a running ingress service after cutover.");
console.log(JSON.stringify({
  result: "swarm edge cutover proof completed",
  previousService: result.previousServiceName,
  edgeServiceId: result.edgeServiceId,
  routerReplicas: oldRouter.desiredReplicas,
  edgeTaskIds: edgeTasks.map((task) => task.id).sort(),
  healthVerified: result.healthVerified,
  servedRoutes: result.servedRoutes,
}));
