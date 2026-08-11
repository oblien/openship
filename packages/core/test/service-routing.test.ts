import { describe, expect, it } from "vitest";

import {
  buildPublicUrlLookup,
  effectiveServiceAlias,
  findPublicUrlPlaceholders,
  firstServicePort,
  hasUnresolvedPlaceholder,
  internalServiceAddress,
  resolvePublicUrlPlaceholders,
  resolvePublicUrlTemplate,
  resolveServiceHostnameLabel,
  MAX_SERVICE_LABEL_LENGTH,
} from "../src/service-routing";

describe("firstServicePort", () => {
  it("reads the container-side port from compose port specs", () => {
    expect(firstServicePort(["8080"])).toBe(8080);
    expect(firstServicePort(["3000:3000"])).toBe(3000);
    expect(firstServicePort(["127.0.0.1:5432:5432"])).toBe(5432);
    expect(firstServicePort(["6379/tcp"])).toBe(6379);
    expect(firstServicePort(["53:53/udp"])).toBe(53);
  });

  it("returns undefined for empty / unparseable input", () => {
    expect(firstServicePort(undefined)).toBeUndefined();
    expect(firstServicePort([])).toBeUndefined();
    expect(firstServicePort([""])).toBeUndefined();
    expect(firstServicePort(["not-a-port"])).toBeUndefined();
  });
});

describe("internalServiceAddress", () => {
  it("is service-name:port — the address a sibling uses (NOT the public subdomain)", () => {
    expect(internalServiceAddress("db", ["5432:5432"])).toBe("db:5432");
    expect(internalServiceAddress("redis", ["6379"])).toBe("redis:6379");
  });

  it("uses the raw service name (docker alias / cloud /etc/hosts entry), unnormalized", () => {
    // A name like "My_DB" is the literal hostname siblings resolve, not a slug.
    expect(internalServiceAddress("My_DB", ["5432"])).toBe("My_DB:5432");
  });

  it("falls back to the bare name when no port is known", () => {
    expect(internalServiceAddress("worker", [])).toBe("worker");
    expect(internalServiceAddress("worker", undefined)).toBe("worker");
  });
});

describe("effectiveServiceAlias", () => {
  it("returns the fallback (service name / slug) when no custom alias is set", () => {
    expect(effectiveServiceAlias("api", undefined)).toBe("api");
    expect(effectiveServiceAlias("api", null)).toBe("api");
    expect(effectiveServiceAlias("api", "")).toBe("api");
  });

  it("prefers the custom alias, DNS-normalized, when it carries usable characters", () => {
    expect(effectiveServiceAlias("api", "gateway")).toBe("gateway");
    // Same normalization the deploy path (aliasExtras → normalizeServiceLabel) and
    // the write validator (normalizeAliasStrict) apply, so the displayed string
    // equals what embedded DNS actually answers.
    expect(effectiveServiceAlias("api", "My Gateway")).toBe("my-gateway");
  });

  it("falls back to the name for an all-symbol alias (no usable DNS chars)", () => {
    // normalizeAliasStrict returns null here (not the "service" fallback), so the
    // stable name shows instead of a meaningless placeholder.
    expect(effectiveServiceAlias("api", "___")).toBe("api");
    expect(effectiveServiceAlias("api", "  ")).toBe("api");
  });
});

describe("resolvePublicUrlPlaceholders", () => {
  // A multi-port service (Convex: API 3210, HTTP actions 3211) resolves each
  // port to its own route; a token with no port hits the primary.
  const urlForService = (name: string, port?: number): string | undefined => {
    if (name !== "backend") return undefined;
    if (port === 3211) return "https://app-backend-http.opsh.io";
    if (port === 3210 || port === undefined) return "https://app-backend.opsh.io";
    return undefined;
  };

  it("resolves a port-specific token to that port's URL", () => {
    const out = resolvePublicUrlPlaceholders(
      {
        CONVEX_CLOUD_ORIGIN: "{{publicUrl:backend:3210}}",
        CONVEX_SITE_ORIGIN: "{{publicUrl:backend:3211}}",
      },
      urlForService,
    );
    expect(out.CONVEX_CLOUD_ORIGIN).toBe("https://app-backend.opsh.io");
    expect(out.CONVEX_SITE_ORIGIN).toBe("https://app-backend-http.opsh.io");
  });

  it("resolves a bare (no-port) token to the primary route (back-compat)", () => {
    const out = resolvePublicUrlPlaceholders(
      { NEXT_PUBLIC_DEPLOYMENT_URL: "{{publicUrl:backend}}" },
      urlForService,
    );
    expect(out.NEXT_PUBLIC_DEPLOYMENT_URL).toBe("https://app-backend.opsh.io");
  });

  it("blanks unknown services / ports rather than leaking the placeholder", () => {
    const out = resolvePublicUrlPlaceholders(
      { A: "{{publicUrl:missing}}", B: "{{publicUrl:backend:9999}}" },
      urlForService,
    );
    expect(out.A).toBe("");
    expect(out.B).toBe("");
  });
});

describe("placeholder totality — a raw {{…}} may never reach a user or a container", () => {
  // Field bug: the Convex app Overview rendered `{{publicUrl:backend:3210}}` as
  // its DEPLOYMENT URL. The token is persisted in the service's env by design
  // (resolved per deploy), so every surface that READS that env has to resolve
  // it — and say so when it can't, instead of passing the token through.
  const CONVEX_ENV = "{{publicUrl:backend:3210}}";

  it("finds every token with its service and port", () => {
    expect(findPublicUrlPlaceholders(CONVEX_ENV)).toEqual([
      { token: "{{publicUrl:backend:3210}}", service: "backend", port: 3210 },
    ]);
    expect(findPublicUrlPlaceholders("{{publicUrl:web}}/callback")).toEqual([
      { token: "{{publicUrl:web}}", service: "web" },
    ]);
    expect(findPublicUrlPlaceholders("https://already.resolved")).toEqual([]);
  });

  it("reports the unresolved token instead of echoing it", () => {
    const out = resolvePublicUrlTemplate(CONVEX_ENV, () => undefined);
    expect(out.value).not.toContain("{{");
    expect(out.unresolved).toEqual([
      { token: "{{publicUrl:backend:3210}}", service: "backend", port: 3210 },
    ]);
  });

  it("resolves to the real URL and reports nothing when a route exists", () => {
    const out = resolvePublicUrlTemplate(CONVEX_ENV, () => "https://convex.example.com");
    expect(out).toEqual({ value: "https://convex.example.com", unresolved: [] });
  });

  it("flags a surviving placeholder of ANY grammar", () => {
    expect(hasUnresolvedPlaceholder(CONVEX_ENV)).toBe(true);
    expect(hasUnresolvedPlaceholder("postgres://u:{{config:PASSWORD}}@db:5432")).toBe(true);
    expect(hasUnresolvedPlaceholder("http://1.2.3.4:3210")).toBe(false);
    expect(hasUnresolvedPlaceholder("")).toBe(false);
    expect(hasUnresolvedPlaceholder(undefined)).toBe(false);
  });
});

describe("buildPublicUrlLookup", () => {
  const CONVEX = [
    {
      name: "backend",
      portPairs: [
        { host: 3210, container: 3210 },
        { host: 3211, container: 3211 },
      ],
      primaryPort: 3210,
    },
  ];

  it("prefers a PERSISTED route over the port fallback", () => {
    const lookup = buildPublicUrlLookup(
      [{ ...CONVEX[0], routedUrls: new Map([[3210, "https://api.example.com"]]) }],
      "203.0.113.9",
    );
    expect(lookup.get("backend:3210")).toBe("https://api.example.com");
    expect(lookup.get("backend")).toBe("https://api.example.com");
    // The unrouted second port stays honest rather than borrowing the first's host.
    expect(lookup.get("backend:3211")).toBe("http://203.0.113.9:3211");
  });

  it("falls back to the reachable host:port when nothing is routed", () => {
    const lookup = buildPublicUrlLookup(CONVEX, "203.0.113.9");
    expect(lookup.get("backend")).toBe("http://203.0.113.9:3210");
    expect(lookup.get("backend:3210")).toBe("http://203.0.113.9:3210");
    expect(lookup.get("backend:3211")).toBe("http://203.0.113.9:3211");
  });

  it("NEVER invents a <slug>.<cloud> hostname for a routeless service", () => {
    // No persisted route and no known host → no URL at all. The caller then
    // reports the token unresolved and the card shows "—". Minting a free
    // subdomain here would advertise a hostname that resolves nowhere.
    const lookup = buildPublicUrlLookup(CONVEX, null);
    expect(lookup.size).toBe(0);
    const { value, unresolved } = resolvePublicUrlTemplate(
      "{{publicUrl:backend:3210}}",
      (name, port) => lookup.get(port !== undefined ? `${name}:${port}` : name),
    );
    expect(value).toBe("");
    expect(unresolved).toHaveLength(1);
  });

  it("maps an asymmetric mapping's CONTAINER port to the published host port", () => {
    // The token names the container port (the route target); reachability is the
    // host port. Keying only host ports left `{{publicUrl:api:3000}}` unresolved.
    const lookup = buildPublicUrlLookup(
      [{ name: "api", portPairs: [{ host: 8080, container: 3000 }], primaryPort: 3000 }],
      "example.internal",
    );
    expect(lookup.get("api:3000")).toBe("http://example.internal:8080");
    expect(lookup.get("api:8080")).toBe("http://example.internal:8080");
    expect(lookup.get("api")).toBe("http://example.internal:8080");
  });

  it("keeps a routed service and an unroutable sibling independent", () => {
    const lookup = buildPublicUrlLookup(
      [
        { name: "web", routedUrls: new Map([[80, "https://shop.example.com"]]), primaryPort: 80 },
        { name: "db", portPairs: [] },
      ],
      null,
    );
    expect(lookup.get("web")).toBe("https://shop.example.com");
    expect(lookup.has("db")).toBe(false);
  });
});

describe("free-subdomain length limit", () => {
  // The cloud rejects a slug past 48 chars with `invalid_slug`, and the box's
  // own edge fails `nginx -t` on a server_name past ~63 — so a generated label
  // that long never routes anywhere. Real case: webmail projects carry a full
  // server UUID in their slug.
  const longProject = "webmail-46f32461-4438-4a61-b54d-2408d0f76d62";

  it("clamps a generated label to the namespace limit", () => {
    const label = resolveServiceHostnameLabel(longProject, "zero-server");
    expect(label.length).toBeLessThanOrEqual(MAX_SERVICE_LABEL_LENGTH);
    expect(label).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
  });

  it("is stable across calls and distinct for labels sharing a prefix", () => {
    const a = resolveServiceHostnameLabel(longProject, "zero-server");
    const b = resolveServiceHostnameLabel(longProject, "zero-server");
    const other = resolveServiceHostnameLabel(`${longProject}-two`, "zero-server");
    expect(a).toBe(b);
    expect(a).not.toBe(other);
  });

  it("leaves short labels untouched", () => {
    expect(resolveServiceHostnameLabel("shop", "api")).toBe("shop-api");
  });

  it("does not silently rewrite an explicit subdomain", () => {
    const explicit = "a".repeat(60);
    expect(resolveServiceHostnameLabel(longProject, "zero-server", explicit)).toBe(explicit);
  });
});
