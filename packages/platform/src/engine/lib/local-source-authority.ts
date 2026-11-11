import type { ExecutionContext } from "../../context";
import { instanceAuthorization } from "./instance-authorization";

/**
 * Reading a server-side local path exposes host files. Native applications
 * confine those paths to configured sourceRoots, but a self-hosted HTTP caller
 * has no equivalent boundary, so file contents require instance authority.
 * Metadata-only scans keep the ordinary deployment/project write permission.
 */
export async function assertLocalSourceContentAccess(ctx: ExecutionContext): Promise<void> {
  if (process.env.OPENSHIP_NATIVE !== "true") await instanceAuthorization.assert(ctx);
}
