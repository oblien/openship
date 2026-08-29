import { describe, expect, it } from "vitest";

import { healthcheckFromForm, healthcheckTestToText } from "./healthcheck-test";

/**
 * The Supabase app stores `test: ["CMD", "pg_isready", …]` — compose's own form.
 * Rendering that array with its engine prefix, then saving the line back, is a
 * second way to produce the failure in #502: the stored command becomes "CMD
 * pg_isready …" and Docker execs a binary named CMD. So the form's two directions
 * have to agree, including for a service whose healthcheck it can't express.
 */
const FIELDS = { test: "", interval: "", timeout: "", startPeriod: "", retries: "" };

describe("healthcheckTestToText", () => {
  it("drops the engine prefix from an argv array", () => {
    expect(healthcheckTestToText(["CMD", "pg_isready", "-U", "postgres"])).toBe(
      "pg_isready -U postgres",
    );
  });

  it("drops the engine prefix from a CMD-SHELL array", () => {
    expect(healthcheckTestToText(["CMD-SHELL", "pg_isready -U posthog"])).toBe(
      "pg_isready -U posthog",
    );
  });

  it("passes a bare argv array and a shell string through", () => {
    expect(healthcheckTestToText(["pg_isready", "-U", "postgres"])).toBe("pg_isready -U postgres");
    expect(healthcheckTestToText("curl -f http://localhost/health")).toBe(
      "curl -f http://localhost/health",
    );
  });

  it("shows nothing for a disabled check or no check at all", () => {
    expect(healthcheckTestToText(["NONE"])).toBe("");
    expect(healthcheckTestToText(undefined)).toBe("");
  });
});

describe("healthcheckFromForm", () => {
  it("writes an untouched catalog test back byte-for-byte", () => {
    const stored = { test: ["CMD", "pg_isready", "-U", "postgres"], retries: 10 };
    const saved = healthcheckFromForm(
      { ...FIELDS, test: healthcheckTestToText(stored.test) },
      stored,
    );
    expect(saved).toEqual({ test: ["CMD", "pg_isready", "-U", "postgres"] });
  });

  it("keeps argv that a shell string would change the meaning of", () => {
    const stored = { test: ["CMD", "mongosh", "--quiet", "--eval", "db.adminCommand('ping')"] };
    const saved = healthcheckFromForm(
      { ...FIELDS, test: healthcheckTestToText(stored.test) },
      stored,
    );
    expect(saved?.test).toEqual(stored.test);
  });

  it("stores an edited command as the shell string the user typed", () => {
    const saved = healthcheckFromForm(
      { ...FIELDS, test: "pg_isready -U app" },
      {
        test: ["CMD", "pg_isready", "-U", "postgres"],
      },
    );
    expect(saved).toEqual({ test: "pg_isready -U app" });
  });

  it("carries the timing fields alongside either shape", () => {
    expect(
      healthcheckFromForm(
        { test: "pg_isready", interval: "5s", timeout: "3s", startPeriod: "10s", retries: "3" },
        null,
      ),
    ).toEqual({
      test: "pg_isready",
      interval: "5s",
      timeout: "3s",
      startPeriod: "10s",
      retries: 3,
    });
  });

  it("preserves a check the form cannot express instead of re-enabling it", () => {
    expect(healthcheckFromForm(FIELDS, { disable: true })).toEqual({ disable: true });
    expect(healthcheckFromForm(FIELDS, { test: ["NONE"] })).toEqual({ test: ["NONE"] });
  });

  it("returns null when the field is cleared, so the stored key is removed", () => {
    expect(healthcheckFromForm(FIELDS, { test: ["CMD", "pg_isready"] })).toBeNull();
    expect(healthcheckFromForm(FIELDS, null)).toBeNull();
  });
});
