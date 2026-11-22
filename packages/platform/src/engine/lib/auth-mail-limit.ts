import { createHmac } from "node:crypto";
import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { z } from "zod";
import { and, db, schema, sql } from "@repo/db";
import { env } from "../config/env";
import { isSaasDeployment } from "../config/saas-deployment";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const DAILY_LIMIT = 10;
const otpEmail = z.email();

/** Reserve one Cloud auth email before Better Auth replaces a code or calls the provider. */
export async function reserveAuthEmail(email: string): Promise<boolean> {
  if (!isSaasDeployment) return true;

  const address = email.trim().toLowerCase();
  const digest = createHmac("sha256", env.BETTER_AUTH_SECRET).update(address).digest("hex");
  const id = `auth-mail-limit:${digest}`;
  const now = Date.now();
  const expiresAt = new Date(now + DAY);
  const record = schema.verification;
  // One expiring auth record per address. The newest ten reservation times are enough
  // for all three rolling windows. A conditional upsert serializes concurrent requests
  // across replicas. Denied attempts neither consume a slot nor extend the cooldown.
  const history = sql`(${record.value}::jsonb)`;
  const below = (limit: number, window: number) =>
    sql`coalesce((${history} ->> ${limit - 1}::int)::bigint, 0) <= ${now - window}`;
  const accepted = await db
    .insert(record)
    .values({
      id,
      identifier: id,
      value: JSON.stringify([now]),
      expiresAt,
    })
    .onConflictDoUpdate({
      target: record.id,
      set: {
        value: sql`(excluded.value::jsonb || (${history} - ${DAILY_LIMIT - 1}::int))::text`,
        expiresAt,
      },
      setWhere: and(below(1, MINUTE), below(5, HOUR), below(DAILY_LIMIT, DAY)),
    })
    .returning();
  return accepted.length === 1;
}

export const authEmailLimit = {
  id: "openship-auth-email-limit",
  hooks: {
    before: [
      {
        matcher: ({ path, body }) =>
          isSaasDeployment &&
          (path === "/email-otp/request-password-reset" ||
            path === "/forget-password/email-otp" ||
            (path === "/email-otp/send-verification-otp" &&
              (body?.type === "email-verification" || body?.type === "forget-password"))),
        handler: createAuthMiddleware(async (ctx) => {
          const email = ctx.body?.email;
          if (typeof email !== "string") return;
          // The generic OTP endpoint validates address syntax itself; keep its error response.
          if (
            ctx.path === "/email-otp/send-verification-otp" &&
            !otpEmail.safeParse(email.toLowerCase()).success
          )
            return;
          // Unknown addresses receive the same response and keep their first signup slot.
          const account = await ctx.context.internalAdapter.findUserByEmail(email);
          if (!account || !(await reserveAuthEmail(account.user.email))) {
            return ctx.json({ success: true });
          }
        }),
      },
    ],
  },
} satisfies BetterAuthPlugin;
