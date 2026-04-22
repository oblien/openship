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
  CLOUD_MODE: z
    .enum(["true", "false", "1", "0", ""])
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  /**
   * Deployment mode — determines the runtime + infrastructure combination:
    *   - "docker"  (default) → Docker runtime + OpenResty routing/SSL (self-hosted)
    *   - "bare"              → Process runtime + OpenResty routing/SSL (self-hosted)
   *   - "cloud"             → Oblien cloud API for everything (auto-set when CLOUD_MODE=true)
   *   - "desktop"           → Bare runtime, no routing/SSL (desktop app)
   */
  DEPLOY_MODE: z.enum(["docker", "bare", "cloud", "desktop"]).default("docker"),

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

  /* ---------- GitHub Auth Strategy ---------- */
  /**
   * Controls how the API authenticates with GitHub:
   *   - "auto"  (default) → inferred from DEPLOY_MODE / CLOUD_MODE
   *   - "app"             → GitHub App installation tokens (cloud)
   *   - "oauth"           → Better Auth OAuth flow only (self-hosted with OAuth)
   *   - "cli"             → `gh auth login` token from the machine (local/desktop)
   *   - "token"           → static GITHUB_TOKEN env var (CI, scripts)
   */
  GITHUB_AUTH_MODE: z.enum(["auto", "app", "oauth", "cli", "token"]).default("auto"),
  /** Static GitHub personal access token — used when GITHUB_AUTH_MODE="token" */
  GITHUB_TOKEN: z.string().optional(),

  /* ---------- Redis ---------- */
  REDIS_URL: z.string().default("redis://localhost:6379"),

  /* ---------- Stripe (Cloud only) ---------- */
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),

  /* ---------- Git Webhooks ---------- */
  GITHUB_APP_ID: z.string().optional(),
  GITHUB_APP_SLUG: z.string().optional(),
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

  /* ---------- Network (self-hosted) ---------- */
  /** Public IP of the server — used for A record instructions in self-hosted mode. */
  SERVER_IP: z.string().optional(),
  /**
   * Base domain for the self-hosted instance (e.g. "example.com").
   * Deployments get a free subdomain: slug.HOST_DOMAIN (e.g. "myapp.example.com").
   * SSL is NOT auto-provisioned for these — only for custom domains.
   */
  HOST_DOMAIN: z.string().optional(),

  /* ---------- Oblien Cloud ---------- */
  OBLIEN_CLIENT_ID: z.string().optional(),
  OBLIEN_CLIENT_SECRET: z.string().optional(),

  /** Openship Cloud API URL — used by local instances to fetch namespace tokens */
  OPENSHIP_CLOUD_URL: z.string().default("https://api.openship.io"),

  /** Openship Cloud dashboard URL — used for external auth redirect (desktop + cloud connect) */
  OPENSHIP_CLOUD_DASHBOARD_URL: z.string().default("https://app.openship.io"),

  /* ---------- Screenshots (optional) ---------- */
  SCREENSHOT_SERVICE_URL: z.string().optional(),
  CDN_UPLOAD_URL: z.string().optional(),

  /* ---------- Internal (Electron ↔ API) ---------- */
  /** Shared secret for Electron → API calls (set by desktop app on startup) */
  INTERNAL_TOKEN: z.string().optional(),

  /** Enables verbose timing logs for SSH/system checks and environment detection */
  SYSTEM_DEBUG_LOGS: z
    .enum(["true", "false", "1", "0", ""])
    .default("")
    .transform((v) => v === "true" || v === "1"),
});

export type Env = z.infer<typeof envSchema>;

export const env = envSchema.parse(process.env);

/** Parsed trusted origins — single source of truth for CORS + Better Auth */
export const trustedOrigins = env.TRUSTED_ORIGINS
  ? env.TRUSTED_ORIGINS.split(",")
  : ["http://localhost:3000", "http://localhost:3001"];

/** Internal loopback URL for the API (used by nginx webhook proxy, etc.) */
export const internalApiUrl = `http://127.0.0.1:${env.PORT}`;
