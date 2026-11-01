import { generateSignedCookie } from "hono/cookie";
import { z } from "zod";
import { instanceOrigin, type InstanceConnection } from "@repo/core";
import { auth } from "@repo/platform/engine/lib/auth";

export const deviceCookieName = /^(?:__Secure-)?openship(?:[-_][a-z0-9-]+)?\.[A-Za-z0-9_.-]+$/;
export const connectionSchema = z.object({
  origin: z.string().transform(instanceOrigin),
  installationId: z.string().uuid(),
  cookies: z
    .record(
      z.string().regex(deviceCookieName),
      z
        .string()
        .max(16_384)
        .regex(/^[\x21-\x3A\x3C-\x7E]*$/),
    )
    .refine((value) => Object.keys(value).length <= 32 && JSON.stringify(value).length <= 64_000),
});

/** The normal Better Auth cookie also works on auth's organization, 2FA and
 * logout endpoints. Reuse its cookie name/secret and Hono's signing helper;
 * never invent a second authentication method for the Desktop bridge. */
export async function deviceConnection(
  origin: string,
  installationId: string,
  token: string,
): Promise<InstanceConnection> {
  const context = await auth.$context;
  const name = context.authCookies.sessionToken.name;
  const cookie = await generateSignedCookie(name, token, context.secret);
  return {
    origin: instanceOrigin(origin),
    installationId,
    cookies: { [name]: cookie.slice(cookie.indexOf("=") + 1).split(";")[0]! },
  };
}
