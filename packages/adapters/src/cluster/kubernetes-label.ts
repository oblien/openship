import { createHash } from "node:crypto";

/** Keep existing valid labels stable. OpenShip IDs may end in '_' or '-', or
 * exceed Kubernetes' 63-character limit; encode those without changing the ID
 * in persistence or collapsing distinct identities by trimming punctuation. */
export function kubernetesIdLabel(id: string): string {
  if (/^[a-z0-9](?:[-a-z0-9_.]{0,61}[a-z0-9])?$/i.test(id)) return id;
  return `id-${createHash("sha256").update(id).digest("hex").slice(0, 60)}`;
}
