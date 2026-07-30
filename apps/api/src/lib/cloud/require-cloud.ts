import { AppError, CLOUD_CAPABILITIES, type CloudCapability } from "@repo/core";
import { platform } from "../controller-helpers";
import { isCloudConnectedForOrg } from "./session";

/**
 * The ONE server-side gate for "this action requires an Openship Cloud
 * connection". Every cloud-requiring capability funnels through here (deploy
 * target, free/managed domains, cloud services, billing, migrate, cloud pages),
 * so there is one connection-truth and one error shape.
 *
 * Truth = `isCloudConnectedForOrg` (live-validated against the SaaS), NOT local
 * token existence (`resolveOrgCloudUserId` is token-retrieval only). SaaS/native
 * is exempt — the platform IS cloud.
 */

const CAPABILITY_MESSAGE: Record<CloudCapability, string> = {
  "cloud-deploy-target":
    "Connect Openship Cloud to deploy to Openship Cloud, or pick one of your servers.",
  "managed-project-domain":
    "Connect Openship Cloud to use a free subdomain — free *.opsh.io domains route through the Openship Cloud edge. Add a custom domain instead, or connect Cloud in Settings.",
  "managed-compose-domains":
    "Connect Openship Cloud to expose services on free *.opsh.io subdomains — they route through the Openship Cloud edge. Use custom domains instead, or connect Cloud in Settings.",
  "cloud-services-catalog": "Connect Openship Cloud to add cloud-managed services.",
  billing: "Connect Openship Cloud to manage billing and usage.",
  "migrate-to-cloud": "Connect Openship Cloud to migrate this project to the cloud.",
  "cloud-pages": "Connect Openship Cloud — this action runs on Openship Cloud.",
  "github-cloud-app": "Connect Openship Cloud to use the GitHub App integration.",
};

export function capabilityMessage(capability: CloudCapability): string {
  return CAPABILITY_MESSAGE[capability];
}

/** Thrown when a cloud-requiring action is attempted while NOT connected. Code +
 *  HTTP status come from the shared registry, so consumers see the same wire
 *  contract they always did. */
export class CloudRequiredError extends AppError {
  constructor(
    public readonly capability: CloudCapability,
    message?: string,
  ) {
    const meta = CLOUD_CAPABILITIES[capability];
    super(message ?? capabilityMessage(capability), meta.httpStatus, meta.code);
    this.name = "CloudRequiredError";
  }
}

export async function requireCloud(
  capability: CloudCapability,
  opts: { organizationId: string },
): Promise<void> {
  if (platform().target === "cloud") return; // SaaS/native — never gated
  if (await isCloudConnectedForOrg(opts.organizationId)) return;
  throw new CloudRequiredError(capability);
}
