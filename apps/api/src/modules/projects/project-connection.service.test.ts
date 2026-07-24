import { describe, it, expect } from "vitest";
import type { AppTemplate } from "@repo/core";
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
