import { describe, it, expect } from "vitest";
import {
  type AppTemplate,
  getOutputService,
  getOutputPort,
  getAppTemplate,
  getAppConnection,
  resolveInternalEndpoint,
  isValidEnvKey,
} from "@repo/core";
import { toInternalUrl, isNetworkUrl } from "./project-connection.util";

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

// Mirrors the real catalog, INCLUDING the order: the console comes first, so
// "first endpoint of the service" is the wrong answer for the S3 API output.
const MINIO = {
  id: "minio",
  endpoints: [
    { service: "minio", port: 9001, label: "Console", kind: "http" },
    { service: "minio", port: 9000, label: "S3 API", kind: "http" },
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
    // returned null for this and forced it to Public. The scheme drops to http:
    // kong terminates plaintext on 8000, the cert lives on the edge.
    expect(toInternalUrl("https://abc.opsh.io", SUPABASE, "kong")).toBe("http://kong:8000/");
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

describe("toInternalUrl — the DECLARED port wins (the resolved value never names the container)", () => {
  it("picks the declared endpoint, not the service's first, for a routed value", () => {
    // GH-631/#632 follow-up: `publicUrl:minio:9000` resolves to a ROUTED domain,
    // which is portless — so the service's first endpoint won and a bucket client
    // was handed MinIO's web console (9001) while the bind reported success.
    expect(toInternalUrl("https://acme-s3.opsh.io", MINIO, "minio", 9000)).toBe(
      "http://minio:9000/",
    );
  });

  it("outranks a published HOST port carried by the resolved value", () => {
    // A `19000:9000` mapping resolves to http://host:19000. No container answers
    // on 19000, so port-matching fell through to the console as well.
    expect(toInternalUrl("http://203.0.113.5:19000", MINIO, "minio", 9000)).toBe(
      "http://minio:9000/",
    );
  });

  it("without a declared port, still falls back to the service's first endpoint", () => {
    expect(toInternalUrl("https://acme-s3.opsh.io", MINIO, "minio")).toBe("http://minio:9001/");
  });
});

describe("toInternalUrl — TLS does not follow the rewrite onto a container port", () => {
  it("keeps a DSN's own scheme (a tcp endpoint is not http)", () => {
    expect(toInternalUrl("postgresql://u:p@host:5432/postgres", SUPABASE, "db")).toBe(
      "postgresql://u:p@db:5432/postgres",
    );
    expect(toInternalUrl("mongodb://root:pw@host:27017/", MONGO, "mongo")).toBe(
      "mongodb://root:pw@mongo:27017/",
    );
  });

  it("leaves an already-plaintext http value alone", () => {
    expect(toInternalUrl("http://203.0.113.5:9000", MINIO, "minio", 9000)).toBe(
      "http://minio:9000/",
    );
  });
});

describe("the REAL MinIO catalog entry resolves internally to its S3 API", () => {
  // Pins catalog + code together: the port fix is inert if the shipped output
  // stops declaring its port, and the wrong endpoint is silent when it happens.
  const minio = getAppTemplate("minio")!;
  const endpointOut = getAppConnection(minio)!.outputs.find((o) => o.id === "endpoint")!;

  it("declares the S3 API port on the endpoint output", () => {
    expect(endpointOut.source).toBe("publicUrl:minio:9000");
    expect(getOutputPort(endpointOut)).toBe(9000);
  });

  it("rewrites a ROUTED S3 url to http://minio:9000 — not the console, not https", () => {
    expect(
      toInternalUrl(
        "https://acme-s3.opsh.io",
        minio,
        getOutputService(endpointOut),
        getOutputPort(endpointOut),
      ),
    ).toBe("http://minio:9000/");
  });
});

describe("getOutputPort", () => {
  it("reads the container port a publicUrl source names", () => {
    expect(getOutputPort({ source: "publicUrl:minio:9000" })).toBe(9000);
  });
  it("returns null when the source names no port", () => {
    expect(getOutputPort({ source: "publicUrl:kong" })).toBeNull();
    expect(getOutputPort({ source: "env:kong:ANON_KEY" })).toBeNull();
    expect(getOutputPort({ source: "template:postgres://{{host}}:5432" })).toBeNull();
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

describe("isNetworkUrl", () => {
  it("returns true for valid network URLs", () => {
    expect(isNetworkUrl("postgresql://postgres:pw@db:5432/postgres")).toBe(true);
    expect(isNetworkUrl("http://203.0.113.5:8000")).toBe(true);
    expect(isNetworkUrl("https://studio.opsh.io")).toBe(true);
    expect(isNetworkUrl("mongodb://root:s3cr3t@mongo:27017/")).toBe(true);
    expect(isNetworkUrl("redis://:secret@redis:6379/0")).toBe(true);
  });

  it("returns false for non-URL strings like tokens, secrets, usernames", () => {
    expect(isNetworkUrl("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.xyz")).toBe(false);
    expect(isNetworkUrl("0198c246743de5d952712004d56b18a8aab8c5a9a56bca04eb7b9d79cc452811")).toBe(false);
    expect(isNetworkUrl("supabase")).toBe(false);
    expect(isNetworkUrl("my-bucket")).toBe(false);
    expect(isNetworkUrl("not a url")).toBe(false);
    expect(isNetworkUrl("")).toBe(false);
    expect(isNetworkUrl("a:b")).toBe(false);
  });
});
