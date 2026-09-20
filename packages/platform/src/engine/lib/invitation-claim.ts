/**
 * Read-side contract for an invitation claim link.
 *
 * Better Auth deliberately protects `organization/get-invitation` with a
 * session. That endpoint is therefore unsuitable for the first page an invited
 * (and possibly brand-new) user opens. This helper exposes only the small,
 * token-bound projection needed by that page and by invited account creation.
 * Keeping both callers on one validity check prevents the preview from saying
 * an invitation is usable when signup would reject it (or vice versa).
 */

import { repos } from "@repo/db";
import { isValidInvitationId, type InvitationAccountCreation } from "@repo/core";

export interface InvitationClaim {
  id: string;
  email: string;
  role: string;
  expiresAt: Date;
  inviterId: string;
  inviterIsInstanceAdmin: boolean;
  organization: {
    id: string;
    name: string;
  };
}

/** Structural rows accepted by the shared claim validator. Keeping this helper
 * independent of a concrete repo/transaction lets the public preview and the
 * locked signup transaction enforce exactly the same lifecycle policy. */
export interface InvitationClaimRecord {
  id: string;
  email: string;
  role: string;
  status: string;
  expiresAt: Date;
  inviterId: string;
  organizationId: string;
}

export interface InvitationClaimOrganization {
  id: string;
  name: string;
}

export interface InvitationClaimInviter {
  id: string;
  role: string;
}

/** One policy for both invitation creation and the public claim-page UI. */
export function invitationAccountCreationMode(input: {
  accountExists: boolean;
  isSaas: boolean;
  inviterIsInstanceAdmin: boolean;
}): InvitationAccountCreation {
  if (input.accountExists) return "existing";
  if (input.isSaas) return "public";
  if (input.inviterIsInstanceAdmin) return "invited";
  return "disabled";
}

/** Pure lifecycle + relationship validation shared by every claim consumer. */
export function invitationClaimFromRecords(
  invitation: InvitationClaimRecord | null | undefined,
  organization: InvitationClaimOrganization | null | undefined,
  inviter: InvitationClaimInviter | null | undefined,
  now = new Date(),
): InvitationClaim | null {
  if (
    !invitation ||
    invitation.status !== "pending" ||
    invitation.expiresAt.getTime() <= now.getTime() ||
    !organization ||
    organization.id !== invitation.organizationId ||
    !inviter ||
    inviter.id !== invitation.inviterId
  ) {
    return null;
  }

  return {
    id: invitation.id,
    email: invitation.email.trim().toLowerCase(),
    role: invitation.role,
    expiresAt: invitation.expiresAt,
    inviterId: invitation.inviterId,
    inviterIsInstanceAdmin: inviter.role === "admin",
    organization: {
      id: organization.id,
      name: organization.name,
    },
  };
}

/**
 * Resolve a pending, unexpired invitation by its unguessable id.
 *
 * Missing organizations/inviters fail closed. Callers intentionally receive
 * `null` for every invalid lifecycle state so the public route does not reveal
 * whether a token was canceled, rejected, expired, or never existed.
 */
export async function resolveInvitationClaim(
  invitationId: string,
  now = new Date(),
): Promise<InvitationClaim | null> {
  // Better Auth's ids are URL-safe opaque tokens. Bound the public lookup so a
  // malformed/oversized path never reaches the database and keep it identical
  // to the dashboard's post-auth return allowlist.
  if (!isValidInvitationId(invitationId)) return null;

  const invitation = await repos.invitation.findById(invitationId);
  if (!invitation) return null;

  const [organization, inviter] = await Promise.all([
    repos.organization.findById(invitation.organizationId),
    repos.user.findById(invitation.inviterId),
  ]);
  return invitationClaimFromRecords(invitation, organization, inviter, now);
}
