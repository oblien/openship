import { createAuthorization } from "@repo/platform";
import { repos } from "@repo/db";
import { grantSourceFor } from "./grant-source";
import { env } from "../config/index";
import { resolveOrgCloudUserId } from "./cloud/transport";

/** Instance-owned policy composition; creating it performs no database reads. */
export const authorization = createAuthorization({
  repos,
  grantSourceFor,
  cloud: {
    isCanonical: () => env.CLOUD_MODE,
    isLinked: async (organizationId) => !!(await resolveOrgCloudUserId(organizationId)),
  },
});

export const checkPermission = authorization.checkPermission;

export const checkPermissionOnResource = authorization.checkPermissionOnResource;
