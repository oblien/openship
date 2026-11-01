/**
 * Authoritative self-hosted invitation signup transaction.
 *
 * The public controller may perform a cheap read-side preflight before hashing
 * a password, but this transaction is the security boundary: it locks the
 * invitation, revalidates its complete claim, and creates every identity row in
 * the same commit. Cancellation cannot race between authorization and account
 * creation, and an inviter cannot be demoted while their authority is consumed.
 */

import { db, repos, eq, ilike, schema } from "@repo/db";
import { AppError, generateId, isValidInvitationId } from "@repo/core";
import { resolveInviter, checkInviter } from "../modules/permissions/organization.service";
import {
  invitationClaimFromRecords,
  type InvitationClaimOrganization,
  type InvitationClaimInviter,
  type InvitationClaimRecord,
} from "@repo/platform/engine/lib/invitation-claim";
import {
  provisionUserWithCredentialInTransaction,
  type ProvisionTransaction,
} from "@repo/platform/engine/lib/provision-user";
import { withInvitationLifecycleLock } from "./invitation-lifecycle-lock";

export type InvitationSignupResult =
  | { status: "created"; email: string }
  | { status: "invalid" }
  | { status: "existing" };

export interface CreateInvitedUserInput {
  invitationId: string;
  name: string;
  passwordHash: string;
  now?: Date;
}

function isUserEmailUniqueViolation(error: unknown): boolean {
  const dbError = error as {
    code?: unknown;
    constraint?: unknown;
    cause?: { code?: unknown; constraint?: unknown };
  } | null;
  const pgError = dbError?.cause?.code === "23505" ? dbError.cause : dbError;
  return pgError?.code === "23505" && pgError.constraint === "user_email_unique";
}

export async function createInvitedUserWithCredential(
  input: CreateInvitedUserInput,
): Promise<InvitationSignupResult> {
  if (!isValidInvitationId(input.invitationId)) return { status: "invalid" };
  try {
    return await withInvitationLifecycleLock(input.invitationId, async () => {
      const before = await repos.invitation.findById(input.invitationId);
      if (!before) return { status: "invalid" } as const;
      const delegatedInviter = before.executionAuthority ? await resolveInviter(before) : null;
      return db.transaction(async (rawTx) => {
        const tx = rawTx as ProvisionTransaction;

        // Match membership/cancellation lock order: organization before invitation.
        const [organization] = await tx
          .select({ id: schema.organization.id, name: schema.organization.name })
          .from(schema.organization)
          .where(eq(schema.organization.id, before.organizationId))
          .limit(1)
          .for("update");

        // This is the revocation barrier. Better Auth cancellation/acceptance
        // updates this row and therefore cannot cross the identity commit.
        const [invitation] = await tx
          .select()
          .from(schema.invitation)
          .where(eq(schema.invitation.id, input.invitationId))
          .limit(1)
          .for("update");
        if (!invitation || invitation.organizationId !== before.organizationId) return { status: "invalid" } as const;

        // Lock the two authority relationships too: deleting the organization or
        // demoting/deleting the inviter cannot invalidate a claim midway through
        // the same transaction.
        const [inviter] = await tx
          .select({ id: schema.user.id, role: schema.user.role })
          .from(schema.user)
          .where(eq(schema.user.id, invitation.inviterId))
          .limit(1)
          .for("share");

        const claim = invitationClaimFromRecords(
          invitation as InvitationClaimRecord,
          organization as InvitationClaimOrganization | undefined,
          inviter as InvitationClaimInviter | undefined,
          // Compute wall-clock time only after acquiring the locks. A request that
          // waited behind cancellation must not validate against its stale start
          // time and create an account after the invitation expired.
          input.now ?? new Date(),
        );
        if (!claim?.inviterIsInstanceAdmin) return { status: "invalid" } as const;
        if (JSON.stringify(invitation.executionAuthority) !== JSON.stringify(before.executionAuthority))
          return { status: "invalid" } as const;
        if (invitation.executionAuthority) {
          if (!delegatedInviter) return { status: "invalid" } as const;
          await checkInviter(rawTx, invitation, delegatedInviter);
        }

        // Case-insensitive UX check inside the transaction. The exact lowercase
        // insert also has the database's unique constraint as the race-safe gate.
        const [existing] = await tx
          .select({ id: schema.user.id })
          .from(schema.user)
          .where(ilike(schema.user.email, claim.email))
          .limit(1);
        if (existing) return { status: "existing" } as const;

        const userId = generateId("usr");
        await provisionUserWithCredentialInTransaction(
          tx,
          {
            id: userId,
            name: input.name,
            email: claim.email,
            emailVerified: true,
          },
          { passwordHash: input.passwordHash },
        );

        return { status: "created", email: claim.email } as const;
      });
    });
  } catch (error) {
    // Two concurrent claim requests converge on the user email constraint. The
    // loser is a normal existing-account response, never a partial identity.
    if (isUserEmailUniqueViolation(error)) return { status: "existing" };
    if (error instanceof AppError && [401, 403, 404, 409].includes(error.statusCode)) return { status: "invalid" };
    throw error;
  }
}
