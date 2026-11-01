import { invitationClaimPath, type InvitationAccountCreation } from "@repo/core";

export { invitationClaimPath, type InvitationAccountCreation } from "@repo/core";

/** Use the active instance's public address, including when the UI is running
 * in Desktop. A localhost browser origin must never replace a missing address. */
export function invitationShareUrl(instanceUrl: string | null, invitationId: string): string {
  if (!instanceUrl) throw new Error("The instance needs a public address to share invitations.");
  const base = new URL(instanceUrl);
  if (!["https:", "http:"].includes(base.protocol) || base.username || base.password || base.search || base.hash)
    throw new Error("The instance address is invalid.");
  return `${base.href.replace(/\/+$/, "")}${invitationClaimPath(invitationId)}`;
}

export interface InvitationPreviewResponse {
  data: {
    invitation: {
      id: string;
      email: string;
      role: string;
      expiresAt: string;
    };
    organization: {
      id: string;
      name: string;
    };
    inviter?: { name: string | null };
    accountCreation: InvitationAccountCreation;
  };
}

export function invitationLoginHref(invitationId: string): string {
  const returnTo = invitationClaimPath(invitationId);
  return `/login?returnTo=${encodeURIComponent(returnTo)}`;
}

export function invitationRegisterHref(invitationId: string): string {
  const returnTo = invitationClaimPath(invitationId);
  return `/register?returnTo=${encodeURIComponent(returnTo)}`;
}

export function invitationEmailMatches(
  sessionEmail: string | null | undefined,
  invitationEmail: string,
): boolean {
  return sessionEmail?.trim().toLowerCase() === invitationEmail.trim().toLowerCase();
}
