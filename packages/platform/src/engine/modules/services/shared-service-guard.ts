import { ValidationError } from "@repo/core";
import { repos } from "@repo/db";

/** Check before touching the live container; the FK is the final DB safeguard. */
export async function assertServiceNotShared(serviceId: string): Promise<void> {
  const links = await repos.projectConnection.listBySourceService(serviceId);
  if (links.length) throw new ValidationError(
    "This service is shared with other projects. Disconnect it from those projects before removing or disabling it.",
  );
}
