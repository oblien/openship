import { createHmac } from "node:crypto";
import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware, formCsrfMiddleware } from "better-auth/api";
import { z } from "zod";
import { repos } from "@repo/db";
import { env } from "../config/env";
import { isSaasDeployment } from "../config/saas-deployment";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const cooldown = { limit: 1, windowMs: MINUTE };
const windows = {
  signup: [cooldown, { limit: 5, windowMs: HOUR }, { limit: 10, windowMs: DAY }],
  recovery: [cooldown],
} as const;
const otpEmail = z.email();
const sendOtpPath = "/email-otp/send-verification-otp";
const resetPaths = new Set(["/email-otp/request-password-reset", "/forget-password/email-otp"]);

export function isAuthOtpEmailPath(path: string | undefined): boolean {
  return path !== undefined && (path === sendOtpPath || resetPaths.has(path));
}

/** Reserve one Cloud auth email before Better Auth replaces a code or calls the provider. */
export async function reserveAuthEmail(
  email: string,
  purpose: keyof typeof windows,
): Promise<boolean> {
  if (!isSaasDeployment) return true;

  const address = email.trim().toLowerCase();
  const digest = createHmac("sha256", env.BETTER_AUTH_SECRET).update(address).digest("hex");
  // Preserve the existing budget for signup and verification on upgrade.
  const key =
    purpose === "signup" ? `auth-mail-limit:${digest}` : `auth-mail-limit:recovery:${digest}`;
  return repos.rateLimit.reserve(key, windows[purpose]);
}

export const authEmailLimit = {
  id: "openship-auth-email-limit",
  hooks: {
    before: [
      {
        matcher: ({ path, body }) =>
          isSaasDeployment &&
          isAuthOtpEmailPath(path) &&
          (path !== sendOtpPath ||
            body?.type === "email-verification" ||
            body?.type === "forget-password"),
        handler: createAuthMiddleware(async (ctx) => {
          // The hook can return before the endpoint runs its own CSRF middleware.
          if (ctx.path === sendOtpPath) await formCsrfMiddleware(ctx);
          const email = ctx.body?.email;
          if (typeof email !== "string") return;
          // The generic OTP endpoint validates address syntax itself; keep its error response.
          if (ctx.path === sendOtpPath && !otpEmail.safeParse(email.toLowerCase()).success) return;
          const purpose =
            ctx.path === sendOtpPath && ctx.body.type === "email-verification"
              ? "signup"
              : "recovery";
          // Unknown addresses receive the same response and keep their first signup slot.
          const account = await ctx.context.internalAdapter.findUserByEmail(email);
          if (
            !account ||
            (purpose === "signup" && account.user.emailVerified) ||
            !(await reserveAuthEmail(account.user.email, purpose))
          ) {
            return ctx.json({ success: true });
          }
        }),
      },
    ],
  },
} satisfies BetterAuthPlugin;
