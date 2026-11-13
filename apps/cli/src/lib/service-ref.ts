import type { CliShipClient } from "./ship-client";

/** Resolve only within the selected project; never fall back to another stack. */
export async function resolveServiceRef(ship: Pick<CliShipClient, "services">, projectId: string, ref: string) {
  if (/^svc_/.test(ref)) return ship.services.get(projectId, ref);
  const services = await ship.services.list(projectId);
  const byId = services.find(service => service.id === ref);
  if (byId) return byId;
  const matches = services.filter(service => service.name === ref);
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw new Error(`"${ref}" matches ${matches.length} services — pass the service id (svc_…).`);
  throw new Error(`No service "${ref}" in this stack. Services: ${services.map(service => service.name).join(", ") || "(none)"}`);
}
