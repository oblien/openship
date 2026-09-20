import { invitationClaimPath, type InvitationAccountCreation } from "@repo/core";

export { invitationClaimPath, type InvitationAccountCreation } from "@repo/core";

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
