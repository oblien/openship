import { resolveEdition } from "@repo/core";
import { env } from "../config/env";

export type InvitationMailSource = "platform" | "cloud";

/** Operator has no Cloud mail relay — a leftover "cloud" row must not send. */
export function resolveInvitationMailSource(
  stored: string | null | undefined,
): InvitationMailSource {
  if (resolveEdition({ cloudMode: env.CLOUD_MODE === true }) === "operator") {
    return "platform";
  }
  return stored === "cloud" ? "cloud" : "platform";
}
