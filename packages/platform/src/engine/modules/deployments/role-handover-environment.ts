import type { DeployEnvironment } from "@repo/adapters";
import { throwIfDeploymentCancelled } from "./deployment-cancellation";
import type { beginRoleHandover } from "./role-handover";

type Journal = Pick<
  Awaited<ReturnType<typeof beginRoleHandover>>,
  "recordWeb" | "stopPreviousWeb" | "committing"
>;

/** Bind the journal at the existing web pipeline's side-effect boundaries.
 * Commit intent follows readiness+routing and precedes irreversible removal. */
export function roleHandoverEnvironment(
  env: DeployEnvironment,
  journal: Journal,
  signal?: AbortSignal,
): DeployEnvironment {
  const committing = async (remove: (id: string) => Promise<void>, id: string) => {
    throwIfDeploymentCancelled(signal);
    await journal.committing();
    await remove(id);
  };
  return {
    ...env,
    activate: async (config, log) => {
      const result = await env.activate(config, log);
      await journal.recordWeb(result.containerId);
      return result;
    },
    ...(env.deactivateRetaining
      ? {
          deactivateRetaining: async (id: string) => {
            await journal.stopPreviousWeb();
            await env.deactivateRetaining!(id);
          },
        }
      : {}),
    ...(env.retireRetainedPrevious
      ? { retireRetainedPrevious: (id: string) => committing(env.retireRetainedPrevious!, id) }
      : {}),
    ...(env.canOverlap ? { deactivate: (id: string) => committing(env.deactivate, id) } : {}),
  };
}
