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
  DATABASE_URL: z.string().default("file:./dev.db"),

  /* ---------- Auth ---------- */
  JWT_SECRET: z.string().default("change-me-in-production"),
  JWT_EXPIRES_IN: z.string().default("15m"),
  JWT_REFRESH_EXPIRES_IN: z.string().default("7d"),

  /* ---------- Redis ---------- */
  REDIS_URL: z.string().default("redis://localhost:6379"),

  /* ---------- Stripe (Cloud only) ---------- */
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),

  /* ---------- Git Providers ---------- */
  GITHUB_APP_ID: z.string().optional(),
  GITHUB_PRIVATE_KEY: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export const env = envSchema.parse(process.env);
