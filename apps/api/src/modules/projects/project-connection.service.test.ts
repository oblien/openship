import { describe, it, expect } from "vitest";
import {
  type AppTemplate,
  getOutputService,
  resolveInternalEndpoint,
  isValidEnvKey,
} from "@repo/core";
import { toInternalUrl } from "./project-connection.util";

// Minimal templates — getAppEndpoints reads `endpoints` when present.
const MONGO = {
  id: "mongodb",
  endpoints: [
    { service: "mongo-express", port: 8081, label: "Mongo Express", kind: "http" },
    { service: "mongo", port: 27017, label: "Database", kind: "tcp" },
  ],
} as unknown as AppTemplate;

const SUPABASE = {
  id: "supabase",
  endpoints: [
    { service: "kong", port: 8000, label: "Studio & API", kind: "http" },
    { service: "db", port: 5432, label: "Database", kind: "tcp" },
  ],
} as unknown as AppTemplate;

describe("toInternalUrl — rewrite a public connection URL to the internal service alias", () => {
  it("rewrites a Mongo host:port to the service alias, keeping creds + port", () => {
    expect(toInternalUrl("mongodb://root:s3cr3t@88.99.101.216:27017/", MONGO)).toBe(
      "mongodb://root:s3cr3t@mongo:27017/",
    );
  });

  it("rewrites a Postgres host:port to the db alias", () => {
    expect(toInternalUrl("postgresql://postgres:pw@88.99.101.216:5432/postgres", SUPABASE)).toBe(
      "postgresql://postgres:pw@db:5432/postgres",
    );
  });

  it("returns null for a portless (domain) URL — not an internal target", () => {
    expect(toInternalUrl("https://studio.opsh.io", SUPABASE)).toBeNull();
  });

  it("returns null when no endpoint matches the URL's port", () => {
    expect(toInternalUrl("mongodb://root:pw@host:9999/", MONGO)).toBeNull();
  });

  it("returns null for an unparseable value or missing template", () => {
    expect(toInternalUrl("not a url", MONGO)).toBeNull();
    expect(toInternalUrl("mongodb://root:pw@host:27017/", undefined)).toBeNull();
  });
});

describe("toInternalUrl — service-aware (declared output.service is authoritative)", () => {
  it("rewrites a PORTLESS public URL to the declared service's endpoint (Kong API)", () => {
    // `publicUrl:kong` resolves to a domain with no :8000; with the declared
    // service, internal mode still reaches kong:8000 — the old port-match
    // returned null for this and forced it to Public.
    expect(toInternalUrl("https://abc.opsh.io", SUPABASE, "kong")).toBe("https://kong:8000/");
  });

  it("uses the DECLARED service even when the URL port matches another service", () => {
    // URL port 8000 belongs to kong, but the output declares `db` → must rewrite
    // to db:5432. Guards the port-coincidence bug in the old resolver.
    expect(toInternalUrl("postgresql://u:p@host:8000/postgres", SUPABASE, "db")).toBe(
      "postgresql://u:p@db:5432/postgres",
    );
  });

  it("returns null when the declared service exposes no endpoint", () => {
    expect(toInternalUrl("https://x.opsh.io", SUPABASE, "ghost")).toBeNull();
  });
});

describe("getOutputService", () => {
  it("prefers an explicit service (needed for template: sources)", () => {
    expect(getOutputService({ service: "db", source: "template:postgres://{{host}}:5432" })).toBe("db");
  });
  it("parses the service from env:/publicUrl: sources", () => {
    expect(getOutputService({ source: "env:kong:ANON_KEY" })).toBe("kong");
    expect(getOutputService({ source: "publicUrl:kong:8000" })).toBe("kong");
  });
  it("returns null for a template: source with no declared service", () => {
    expect(getOutputService({ source: "template:postgres://{{host}}:5432" })).toBeNull();
  });
});

describe("resolveInternalEndpoint", () => {
  const MULTI = {
    endpoints: [
      { service: "db", port: 5432, label: "primary", kind: "tcp" },
      { service: "db", port: 6543, label: "pooler", kind: "tcp" },
    ],
  } as unknown as AppTemplate;

  it("prefers the endpoint whose port matches the URL's own", () => {
    expect(resolveInternalEndpoint(MULTI, "db", 6543)).toEqual({ service: "db", port: 6543 });
  });
  it("falls back to the first endpoint of the service", () => {
    expect(resolveInternalEndpoint(SUPABASE, "kong")).toEqual({ service: "kong", port: 8000 });
  });
  it("returns null when the service exposes no endpoint", () => {
    expect(resolveInternalEndpoint(SUPABASE, "ghost")).toBeNull();
  });
});

describe("isValidEnvKey", () => {
  it("accepts POSIX env names and rejects the rest", () => {
    expect(isValidEnvKey("DATABASE_URL")).toBe(true);
    expect(isValidEnvKey("_x1")).toBe(true);
    expect(isValidEnvKey("1BAD")).toBe(false);
    expect(isValidEnvKey("has-dash")).toBe(false);
    expect(isValidEnvKey("")).toBe(false);
  });
});
