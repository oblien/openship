/**
 * Shared "find the org actor" helper.
 *
 * Several background paths need to attribute work to a member of an org —
 * usually the owner (for GitHub App installs, cloud-bridge calls, billing
 * notifications). Before this helper, the same `listByOrganization → find
 * role==="owner"` snippet was copy-pasted in 6 places, half of them with
 * subtly different fallbacks.
 *
 * Pick a fallback per caller:
 *   - "throw"        — for cloud-bridge / install operations that must
 *                       have an owner (no work to do without one).
 *   - "first-member" — for notifications / audit fallback where SOMEONE
 *                       needs to receive the email, even if the owner
 *                       isn't set yet (rare race during org creation).
 *   - "null"         — default; the caller decides what to do with a
 *                       missing owner.
 */

import { repos } from "@repo/db";

type OrgMember = Awaited<
  ReturnType<typeof repos.member.listByOrganization>
>[number];

export type OrgActorFallback = "throw" | "first-member" | "null";

export async function resolveOrgOwner(
  organizationId: string,
  fallback: OrgActorFallback = "null",
): Promise<OrgMember | null> {
  const members = await repos.member.listByOrganization(organizationId);
  const owner = members.find((m) => m.role === "owner");
  if (owner) return owner;
  if (fallback === "first-member") return members[0] ?? null;
  if (fallback === "throw") {
    throw new Error(
      `Organization ${organizationId} has no owner — cannot resolve org actor`,
    );
  }
  return null;
}
