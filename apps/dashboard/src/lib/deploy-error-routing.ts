import { parseCloudRequiredCode, type CloudCapability } from "@repo/core";

/**
 * Where a failed deploy attempt's error should go.
 *
 * The deploy catch has three possible destinations — the cloud-connect modal, the
 * missing-credential modal, or a toast — and exactly one rule that has to hold: if
 * no modal actually opens, the error MUST be toasted. Breaking that is invisible in
 * review and total in effect; the user clicks Deploy, the button resets, and the
 * server's reason is only in devtools.
 */

/**
 * Should a `CLOUD_REQUIRED_*` deploy failure open the cloud-connect modal?
 *
 * Only when connecting is genuinely the missing step. `requireCloud` short-circuits
 * to `true` the moment the dashboard believes it is already connected — it opens no
 * modal and asks the user nothing — so the caller's `if (!connected) showToast(...)`
 * treated that short-circuit as "the user resolved it" and swallowed the error
 * entirely. That is the state this predicate exists to catch: a server refusing a
 * managed domain WHILE the dashboard thinks cloud is connected is a real
 * disagreement between the two, and the one case that most needs saying out loud.
 *
 * Returns false when there is nothing a modal could add — not a cloud code, this
 * deploy mode can't connect cloud at all (SaaS already has it natively), or we are
 * already connected — leaving the caller to fall through to the toast.
 */
export function shouldPromptCloudConnect(opts: {
  /** `body.code` from the API error, if any. */
  errorCode: string | null | undefined;
  /** This platform can hold a cloud connection at all (self-hosted / desktop). */
  canConnectCloud: boolean;
  /** What the dashboard currently believes — `useCloud().connected`. */
  cloudConnected: boolean;
}): boolean {
  if (!opts.canConnectCloud || opts.cloudConnected) return false;
  return parseCloudRequiredCode(opts.errorCode) !== null;
}

/** The capability behind a `CLOUD_REQUIRED_*` code, for the modal's copy. */
export function deployErrorCloudCapability(
  errorCode: string | null | undefined,
): CloudCapability | null {
  return parseCloudRequiredCode(errorCode);
}
