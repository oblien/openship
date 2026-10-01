import { isInvitationClaimPath } from "@repo/core";
import { validateReturnTo } from "./cloud-auth";

/**
 * A self-hosted instance creates accounts only through its token-bound
 * invitation claim page. Keep the public SaaS registration page available,
 * but send self-hosted visitors back to sign-in or to the valid claim they
 * arrived with.
 */
export function selfHostedRegisterRedirect(
  selfHosted: boolean,
  pathWithSearch: string,
): string | null {
  if (!selfHosted) return null;

  const url = new URL(pathWithSearch || "/", "http://openship.local");
  if (url.pathname !== "/register" && url.pathname !== "/register/") return null;

  const returnTo = validateReturnTo(url.searchParams.get("returnTo"));
  const claimPath = returnTo?.split(/[?#]/)[0];
  if (returnTo && claimPath && isInvitationClaimPath(claimPath)) return returnTo;

  return "/login";
}
