import { AppError } from "@repo/core";
import { env } from "../config/env";
import { boxOwningOrgId } from "./box-org";
import { nativeHostExecutionEnabled } from "../native/execution-policy";

interface SshCredentialSettings {
  sshAuthMethod?: string | null;
  sshPrivateKey?: string | null;
  sshKeyPath?: string | null;
  sshTransport?: string | null;
  sshJumpHost?: string | null;
}

/** Account-owned SSH credentials can be used by any authorized organization.
 * The operator's files, agent and local tunnel identity belong to the host's
 * organization. This gate also protects retained/imported server records. */
export async function assertOperatorSshAccess(
  settings: SshCredentialSettings,
  organizationId?: string | null,
  localBootstrap = false,
): Promise<void> {
  const operatorIdentity =
    settings.sshAuthMethod === "agent" ||
    (settings.sshAuthMethod === "key" && !settings.sshPrivateKey && !!settings.sshKeyPath) ||
    settings.sshTransport === "cloudflare" ||
    !!settings.sshJumpHost?.trim();
  if (!operatorIdentity) return;
  // Match local execution policy for an embedding application's explicit opt-in.
  // SaaS never inherits that permission, even when the native SDK is enabled.
  if (!env.CLOUD_MODE && process.env.OPENSHIP_NATIVE === "true" && nativeHostExecutionEnabled())
    return;
  // The only bootstrap caller has already proved a local, unconfigured instance.
  if (
    !env.CLOUD_MODE &&
    (localBootstrap || (organizationId && organizationId === (await boxOwningOrgId())))
  )
    return;
  throw new AppError(
    "This connection uses the control-plane operator's SSH credentials. Use direct SSH with a password or upload your own private key for this workspace.",
    403,
    "OPERATOR_SSH_ACCESS_REQUIRED",
  );
}
