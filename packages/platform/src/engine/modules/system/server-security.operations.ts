import type { ServerDependencies } from "../../../servers";

// Advisory feeds and their authentication dependencies initialize on demand.
// Server reads, connectivity checks and removal only need the server operation group.
const load = () => import("../updates/host-security");

export const serverSecurityResources: Pick<
  ServerDependencies["resources"],
  "security" | "checkSecurity" | "planSecurityPatch" | "applySecurityPatch" | "securityRuns"
> = {
  async security(ctx, id) {
    return (await load()).serverSecurityResources.security(ctx, id);
  },
  async checkSecurity(ctx, id) {
    return (await load()).serverSecurityResources.checkSecurity(ctx, id);
  },
  async planSecurityPatch(ctx, id, input) {
    return (await load()).serverSecurityResources.planSecurityPatch(ctx, id, input);
  },
  async applySecurityPatch(ctx, id, input) {
    return (await load()).serverSecurityResources.applySecurityPatch(ctx, id, input);
  },
  async securityRuns(ctx, id) {
    return (await load()).serverSecurityResources.securityRuns(ctx, id);
  },
};
