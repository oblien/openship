import { afterEach, describe, expect, it } from "vitest";

import {
  MAIL_DB_DEFAULT_PORT,
  MAIL_DB_FALLBACK_PORT,
  MAIL_DB_PORT_RANGE_MAX,
  MAIL_DB_INTERNAL_PORT,
  resolveMailDbPort,
} from "./mail-container";

const originalEnv = process.env.OPENSHIP_MAIL_DB_PORT;

afterEach(() => {
  if (originalEnv === undefined) {
    delete process.env.OPENSHIP_MAIL_DB_PORT;
  } else {
    process.env.OPENSHIP_MAIL_DB_PORT = originalEnv;
  }
});

describe("resolveMailDbPort", () => {
  it("defaults to 5432 when no argument or env var is present", () => {
    delete process.env.OPENSHIP_MAIL_DB_PORT;
    expect(resolveMailDbPort()).toBe(5432);
    expect(resolveMailDbPort(undefined)).toBe(5432);
    expect(resolveMailDbPort("")).toBe(5432);
  });

  it("reads from OPENSHIP_MAIL_DB_PORT environment variable", () => {
    process.env.OPENSHIP_MAIL_DB_PORT = "5433";
    expect(resolveMailDbPort()).toBe(5433);
  });

  it("parses valid port numbers and strings", () => {
    expect(resolveMailDbPort("5433")).toBe(5433);
    expect(resolveMailDbPort(" 5434 ")).toBe(5434);
    expect(resolveMailDbPort(5435)).toBe(5435);
    expect(resolveMailDbPort(1)).toBe(1);
    expect(resolveMailDbPort(65535)).toBe(65535);
  });

  it("falls back to default 5432 on invalid or out-of-range ports", () => {
    expect(resolveMailDbPort("0")).toBe(MAIL_DB_DEFAULT_PORT);
    expect(resolveMailDbPort("-1")).toBe(MAIL_DB_DEFAULT_PORT);
    expect(resolveMailDbPort("65536")).toBe(MAIL_DB_DEFAULT_PORT);
    expect(resolveMailDbPort("not-a-port")).toBe(MAIL_DB_DEFAULT_PORT);
    expect(resolveMailDbPort("5432.5")).toBe(MAIL_DB_DEFAULT_PORT);
  });

  it("exports matching internal and default port constants", () => {
    expect(MAIL_DB_DEFAULT_PORT).toBe(5432);
    expect(MAIL_DB_INTERNAL_PORT).toBe(5432);
    expect(MAIL_DB_FALLBACK_PORT).toBe(5433);
    expect(MAIL_DB_PORT_RANGE_MAX).toBe(5460);
  });
});
