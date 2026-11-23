import type { ExecutionContext } from "../../../context";
import type { PreflightCheck } from "../deployments/preflight";

export const GIT_PREFLIGHT_ERROR_CODES = {
  GITHUB_APP_INSTALLATION_REQUIRED: "GITHUB_APP_INSTALLATION_REQUIRED",
  REMOTE_BUILD_TOKEN_LEAK_RISK: "REMOTE_BUILD_TOKEN_LEAK_RISK",
  /** gh CLI auth + remote-server build target. clone-auth.ts will throw
   *  GITHUB_CLI_REMOTE_BUILD_REJECTED at deploy time — surface it earlier
   *  so the user can fix it before provisioning starts. */
  GITHUB_CLI_REMOTE_BUILD_REJECTED: "GITHUB_CLI_REMOTE_BUILD_REJECTED",
  /** No remote-safe clone token resolvable for the project's owner.
   *  Atomic — same `tokenFor(purpose:"remote")` resolver that clone-auth
   *  uses at deploy time. Failing here surfaces the missing-credential
   *  modal up-front instead of letting the build pipeline fail later. */
  GITHUB_REMOTE_TOKEN_REQUIRED: "GITHUB_REMOTE_TOKEN_REQUIRED",
} as const;

export interface GitPreflightInput {
  ctx: ExecutionContext | null;
  namespace?: string | null;
  name?: string | null;
  projectId?: string;
  effectiveTarget: string;
  buildStrategy?: "local" | "server";
  serverId?: string;
  platformTarget: string;
  forwardGitCredentials?: boolean;
  remoteCredential: boolean;
  clonesOnRemote: boolean;
  dockerClonesOnTarget: boolean;
  canStageSourceOnApiHost?: boolean;
}

export interface GitPreflight {
  isPublicRepository(
    url?: string,
    namespace?: string | null,
    name?: string | null,
  ): Promise<boolean>;
  checks(input: GitPreflightInput): Promise<PreflightCheck[]>;
}
