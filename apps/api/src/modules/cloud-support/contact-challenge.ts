import { AppError } from "@repo/core";
import { reportCaughtError } from "@repo/core/diagnostics";
import { env } from "@repo/platform/engine/config/env";

/** Public API verifies the challenge itself so bypassing the website cannot skip it. */
export async function verifyContactChallenge(token: string, clientIp?: string | null) {
  if (!env.CONTACT_TURNSTILE_SECRET)
    throw new AppError(
      "Contact is temporarily unavailable. Please try again later.",
      503,
      "CONTACT_UNAVAILABLE",
    );
  let result: { success?: boolean; hostname?: string; action?: string };
  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: new URLSearchParams({
        secret: env.CONTACT_TURNSTILE_SECRET,
        response: token,
        ...(clientIp ? { remoteip: clientIp } : {}),
      }),
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
    if (!response.ok) throw new Error("Challenge provider unavailable");
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new Error("Invalid challenge response");
    result = body as typeof result;
  } catch (error) {
    reportCaughtError(error, "api/cloud-support/contact-challenge");
    throw new AppError(
      "Couldn't verify the bot check. Please try again.",
      503,
      "CONTACT_CHALLENGE_UNAVAILABLE",
    );
  }
  const hosts = env.CONTACT_TURNSTILE_HOSTNAMES.split(",")
    .map((host) => host.trim())
    .filter(Boolean);
  if (
    result.success !== true ||
    result.action !== "contact" ||
    !result.hostname ||
    !hosts.includes(result.hostname)
  )
    throw new AppError("Complete the bot check and try again.", 403, "CONTACT_CHALLENGE_REQUIRED");
}
