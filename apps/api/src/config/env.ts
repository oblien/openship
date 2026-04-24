import { z } from "zod";

const DEFAULT_BETTER_AUTH_SECRET = "change-me-in-production";
const DEFAULT_BETTER_AUTH_URL = "http://localhost:4000";
const DEFAULT_DASHBOARD_URL = "http://localhost:3001";
const DEFAULT_OPENSHIP_CLOUD_URL = "https://api.openship.io";
const DEFAULT_OPENSHIP_CLOUD_DASHBOARD_URL = "https://app.openship.io";

const httpUrl = z.string().url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, {
  message: "must be a valid http(s) URL",
});

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
  BETTER_AUTH_SECRET: z.string().min(1).default(DEFAULT_BETTER_AUTH_SECRET),
  BETTER_AUTH_URL: httpUrl.default(DEFAULT_BETTER_AUTH_URL),
  BETTER_AUTH_COOKIE_DOMAIN: z.string().optional(),
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

  /* ---------- GitHub App ---------- */
  GITHUB_APP_ID: z.string().optional(),
  GITHUB_APP_SLUG: z.string().optional(),
  /** PEM private key — raw multi-line string */
  GITHUB_PRIVATE_KEY: z.string().optional(),
  /** PEM private key — base64-encoded (single-line, for env vars) */
  GITHUB_PRIVATE_KEY_BASE64: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().optional(),

  /* ---------- Email (SMTP) ---------- */
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().default("Openship <noreply@openship.dev>"),

  /* ---------- Dashboard ---------- */
  DASHBOARD_URL: httpUrl.default(DEFAULT_DASHBOARD_URL),

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
  OPENSHIP_CLOUD_URL: httpUrl.default(DEFAULT_OPENSHIP_CLOUD_URL),

  /** Openship Cloud dashboard URL — used for external auth redirect (desktop + cloud connect) */
  OPENSHIP_CLOUD_DASHBOARD_URL: httpUrl.default(DEFAULT_OPENSHIP_CLOUD_DASHBOARD_URL),

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

function normalizeHttpOrigin(value: string, source: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }

    url.pathname = "/";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    throw new Error(`${source} must be a valid http(s) origin.`);
  }
}

function parseTrustedOrigins(rawOrigins?: string) {
  if (!rawOrigins?.trim()) {
    return undefined;
  }

  return rawOrigins
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map((origin) => normalizeHttpOrigin(origin, "TRUSTED_ORIGINS"));
}

function unique(values: string[]) {
  return [...new Set(values)];
}

function validateProductionConfig(parsedEnv: Env) {
  if (parsedEnv.NODE_ENV !== "production") {
    return;
  }

  const errors: string[] = [];

  if (parsedEnv.BETTER_AUTH_SECRET === DEFAULT_BETTER_AUTH_SECRET) {
    errors.push("BETTER_AUTH_SECRET must be set to a secure value in production.");
  }

  if (parsedEnv.BETTER_AUTH_URL === DEFAULT_BETTER_AUTH_URL) {
    errors.push("BETTER_AUTH_URL must be set to the public API URL in production.");
  }

  if (parsedEnv.DASHBOARD_URL === DEFAULT_DASHBOARD_URL) {
    errors.push("DASHBOARD_URL must be set to the public dashboard URL in production.");
  }

  if (errors.length > 0) {
    throw new Error(errors.join(" "));
  }
}

const parsedEnv = envSchema.parse(process.env);
validateProductionConfig(parsedEnv);

export const env = parsedEnv;

/** Parsed trusted origins — single source of truth for CORS + Better Auth */
export const trustedOrigins = parseTrustedOrigins(env.TRUSTED_ORIGINS)
  ?? unique([
    normalizeHttpOrigin(env.DASHBOARD_URL, "DASHBOARD_URL"),
    normalizeHttpOrigin(env.BETTER_AUTH_URL, "BETTER_AUTH_URL"),
    ...(env.NODE_ENV === "production"
      ? []
      : ["http://localhost:3000", "http://localhost:3001"]),
  ]);

/** Internal loopback URL for the API (used by nginx webhook proxy, etc.) */
export const internalApiUrl = `http://127.0.0.1:${env.PORT}`;
