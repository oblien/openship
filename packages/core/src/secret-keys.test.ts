import { describe, expect, it } from "vitest";

import { looksLikeSecretKey } from "./secret-keys";

/**
 * #587: a pasted `.env` stored every variable with `isSecret: false`, so real
 * credentials came back in cleartext from `GET /projects/:id/env` and rendered as
 * readable text in the editor.
 *
 * The bias is deliberate and asymmetric: a false positive costs one click on the
 * editor's secret toggle and leaks nothing; a false negative publishes a live
 * credential. The exclusions exist so that bias does not become noise on names that
 * merely *contain* a secret word.
 */

describe("looksLikeSecretKey — credentials", () => {
  it.each([
    "OPENAI_API_KEY",
    "STRIPE_SECRET_KEY",
    "SECRET",
    "JWT_SECRET",
    "BETTER_AUTH_SECRET",
    "GITHUB_TOKEN",
    "POSTGRES_PASSWORD",
    "DB_PASSWD",
    "SMTP_PASS",
    "AWS_ACCESS_KEY_ID_SECRET",
    "APIKEY",
    "PRIVATE_KEY",
    "PRIVATEKEY",
    "SESSION_KEY",
    "ENCRYPTION_KEY",
    "MY_CREDENTIALS",
    "WEBHOOK_SIGNATURE",
    "PASSWORD_SALT",
    "TLS_CERT",
    "SENTRY_DSN",
  ])("marks %s", (key) => {
    expect(looksLikeSecretKey(key)).toBe(true);
  });

  it("marks connection strings, whose values embed user:password@", () => {
    // Checked BEFORE the `_URL`-adjacent exclusions, which would otherwise clear them.
    for (const key of [
      "DATABASE_URL",
      "DB_URL",
      "POSTGRES_URL",
      "POSTGRESQL_URI",
      "MYSQL_URL",
      "MONGODB_URI",
      "REDIS_URL",
      "AMQP_URL",
      "SMTP_URL",
      "CONNECTION_STRING",
      "CLICKHOUSE_DSN",
    ]) {
      expect(looksLikeSecretKey(key), key).toBe(true);
    }
  });

  it("matches camelCase too", () => {
    expect(looksLikeSecretKey("apiKey")).toBe(true);
    expect(looksLikeSecretKey("stripeSecretKey")).toBe(true);
  });
});

describe("looksLikeSecretKey — ordinary config", () => {
  it.each([
    // The reporter's own examples, all wrongly flagged in their reading of the bug.
    "MAX_CONCURRENCY",
    "EXTRACT_MODEL",
    "INGEST_WINDOW_DAYS",
    "NODE_ENV",
    "PORT",
    "LOG_LEVEL",
    "TZ",
    "APP_NAME",
    "BASE_URL",
    "NEXT_PUBLIC_API_URL",
  ])("leaves %s alone", (key) => {
    expect(looksLikeSecretKey(key)).toBe(false);
  });

  it("does not match a secret word inside an unrelated word", () => {
    // Word-boundary matching, not substring: these are the classic false positives.
    expect(looksLikeSecretKey("KEYCLOAK_URL")).toBe(false);
    expect(looksLikeSecretKey("MONKEY_NAME")).toBe(false);
    expect(looksLikeSecretKey("PASSENGER_COUNT")).toBe(false);
  });

  it("excludes names that describe a secret rather than hold one", () => {
    expect(looksLikeSecretKey("PUBLIC_KEY")).toBe(false);
    expect(looksLikeSecretKey("SSH_KEY_PATH")).toBe(false);
    expect(looksLikeSecretKey("TLS_CERT_FILE")).toBe(false);
    expect(looksLikeSecretKey("KEY_PREFIX")).toBe(false);
    expect(looksLikeSecretKey("AWS_ACCESS_KEY_ID")).toBe(false);
    expect(looksLikeSecretKey("AUTH_URL")).toBe(false);
    expect(looksLikeSecretKey("AUTH_ENABLED")).toBe(false);
    expect(looksLikeSecretKey("TOKEN_TTL")).toBe(false);
    expect(looksLikeSecretKey("REQUIRE_AUTH")).toBe(false);
  });

  it("handles blank and punctuation-only input", () => {
    expect(looksLikeSecretKey("")).toBe(false);
    expect(looksLikeSecretKey("   ")).toBe(false);
    expect(looksLikeSecretKey("___")).toBe(false);
  });
});
