import {
  INVITATION_DELIVERY_HEADER,
  INVITATION_DELIVERY_LINK_ONLY,
} from "@repo/core";

/** True only for the authenticated invite request's explicit link-only mode. */
export function invitationNeedsEmail(request?: Request): boolean {
  return (
    request?.headers.get(INVITATION_DELIVERY_HEADER) !==
    INVITATION_DELIVERY_LINK_ONLY
  );
}
