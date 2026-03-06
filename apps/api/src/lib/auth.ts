import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db, schema } from "@repo/db";
import { env } from "../config/env";
import { sendMail, smtpEnabled } from "./mail";
import { resetPasswordEmail, verifyEmailTemplate } from "./email-templates";

/**
 * Better Auth — handles registration, login, OAuth, sessions, tokens.
 *
 * Browser clients (dashboard) use httpOnly session cookies.
 * API clients (CLI, external) use Bearer tokens via the session token.
 *
 * Routes are mounted at /api/auth/* in app.ts.
 */
export const auth = betterAuth({
  basePath: "/api/auth",
  baseURL: env.BETTER_AUTH_URL,

  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: schema.user,
      session: schema.session,
      account: schema.account,
      verification: schema.verification,
    },
  }),

  /* ---------- Email + Password ---------- */
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    maxPasswordLength: 128,

    /* Password reset — only functional when SMTP is configured */
    sendResetPassword: smtpEnabled
      ? async ({ user, url }) => {
          const email = resetPasswordEmail(user, url);
          await sendMail({ to: user.email, ...email });
        }
      : undefined,

    /* Email verification — only functional when SMTP is configured */
    requireEmailVerification: smtpEnabled,
    sendVerificationEmail: smtpEnabled
      ? async ({ user, url }) => {
          const email = verifyEmailTemplate(user, url);
          await sendMail({ to: user.email, ...email });
        }
      : undefined,
  },

  /* ---------- OAuth Providers ---------- */
  socialProviders: {
    ...(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
      ? {
          github: {
            clientId: env.GITHUB_CLIENT_ID,
            clientSecret: env.GITHUB_CLIENT_SECRET,
          },
        }
      : {}),
    ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
      ? {
          google: {
            clientId: env.GOOGLE_CLIENT_ID,
            clientSecret: env.GOOGLE_CLIENT_SECRET,
          },
        }
      : {}),
  },

  /* ---------- Session ---------- */
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24,      // refresh session every 24h
  },

  /* ---------- Custom fields on user ---------- */
  user: {
    additionalFields: {
      role: {
        type: "string",
        defaultValue: "user",
        input: false,
      },
    },
  },

  /* ---------- Security ---------- */
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins: env.TRUSTED_ORIGINS ? env.TRUSTED_ORIGINS.split(",") : ["http://localhost:3000", "http://localhost:3001"],
});

export type Auth = typeof auth;
