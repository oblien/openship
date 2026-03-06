import { z } from "zod";

/**
 * API configuration — loaded from environment variables.
 *
 * CLOUD_MODE=true enables billing, metering, and multi-tenant features.
 * CLOUD_MODE=false (default) runs as a self-hosted single-tenant instance.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(4000),

  /* ---------- Mode ---------- */
  CLOUD_MODE: z.coerce.boolean().default(false),

  /* ---------- Database ---------- */
  DATABASE_URL: z.string().default(""),

  /* ---------- Auth (Better Auth) ---------- */
  BETTER_AUTH_SECRET: z.string().default("change-me-in-production"),
  BETTER_AUTH_URL: z.string().default("http://localhost:4000"),
  TRUSTED_ORIGINS: z.string().optional(),

  /* ---------- OAuth Providers ---------- */
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),

  /* ---------- Redis ---------- */
  REDIS_URL: z.string().default("redis://localhost:6379"),

  /* ---------- Stripe (Cloud only) ---------- */
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),

  /* ---------- Git Webhooks ---------- */
  GITHUB_APP_ID: z.string().optional(),
  GITHUB_PRIVATE_KEY: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().optional(),

  /* ---------- Email (SMTP) ---------- */
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().default("Openship <noreply@openship.dev>"),

  /* ---------- Dashboard ---------- */
  DASHBOARD_URL: z.string().default("http://localhost:3001"),
});

export type Env = z.infer<typeof envSchema>;

export const env = envSchema.parse(process.env);
