import { createHash } from "node:crypto";
import { constantTimeEqual, generateRandomString } from "better-auth/crypto";
import {
  CLOUD_DEVICE_USER_CODE_LENGTH,
  normalizeCloudDeviceUserCode,
  type CloudDeviceAuthorization,
} from "@repo/contracts";
import { auth } from "@repo/platform/engine/lib/auth";

const EXPIRES_IN = 5 * 60;
const identifier = (state: string) => `openship-cloud-device:${state}`;
const proof = (codeChallenge: string, userCode: string) =>
  `${codeChallenge}:${createHash("sha256").update(normalizeCloudDeviceUserCode(userCode)).digest("base64url")}`;

/** Keep the existing Cloud handoff; Better Auth owns random generation,
 * verification storage and atomic consumption across Cloud processes.
 */
export async function issueDeviceAuthorization(
  codeChallenge: string,
): Promise<CloudDeviceAuthorization> {
  const state = generateRandomString(32);
  const rawCode = generateRandomString(CLOUD_DEVICE_USER_CODE_LENGTH, "A-Z", "0-9");
  const userCode = `${rawCode.slice(0, 4)}-${rawCode.slice(4)}`;
  const adapter = (await auth.$context).internalAdapter;
  await adapter.createVerificationValue({
    identifier: identifier(state),
    value: proof(codeChallenge, userCode),
    expiresAt: new Date(Date.now() + EXPIRES_IN * 1000),
  });
  return { state, user_code: userCode, expires_in: EXPIRES_IN };
}

/** Read-only entry check. Approval performs the authoritative consumption. */
export async function validateDeviceAuthorization(
  state: string,
  codeChallenge: string,
): Promise<boolean> {
  const adapter = (await auth.$context).internalAdapter;
  const request = await adapter.findVerificationValue(identifier(state));
  return (
    !!request &&
    request.expiresAt.getTime() > Date.now() &&
    request.value.startsWith(`${codeChallenge}:`)
  );
}

/** Called only after authenticating the approving Cloud session. A wrong code
 * leaves the request usable; only one valid concurrent approval can consume it.
 */
export async function consumeDeviceAuthorization(
  state: string,
  codeChallenge: string,
  userCode: string,
): Promise<boolean> {
  const adapter = (await auth.$context).internalAdapter;
  const key = identifier(state);
  const request = await adapter.findVerificationValue(key);
  const expected = proof(codeChallenge, userCode);
  if (!request || !constantTimeEqual(request.value, expected)) return false;
  const consumed = await adapter.consumeVerificationValue(key);
  return !!consumed && constantTimeEqual(consumed.value, expected);
}
