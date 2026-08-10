import { describe, expect, it, vi } from "vitest";
import { certFromAcmeJson, traefikAcmeCert } from "./traefik-certs";
import type { CommandExecutor } from "../../../types";

// Traefik keeps every cert in one JSON blob with base64 PEMs and no cert files on
// disk, so the label parser can't declare a path — which is why every Traefik box
// re-issued through ACME on migrate instead of carrying what it already had.

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const PEM_CERT = "-----BEGIN CERTIFICATE-----\nMIIC\n-----END CERTIFICATE-----";
const PEM_KEY = "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----";

const acme = (entries: unknown[], resolver = "le") =>
  JSON.stringify({ [resolver]: { Account: { Email: "a@b.c" }, Certificates: entries } });

const entry = (main: string, sans: string[] = []) => ({
  domain: { main, sans },
  certificate: b64(PEM_CERT),
  key: b64(PEM_KEY),
});

describe("certFromAcmeJson", () => {
  it("decodes the base64 PEMs for a matching main domain", () => {
    const got = certFromAcmeJson(acme([entry("a.com")]), "a.com");
    expect(got).toEqual({ certPem: PEM_CERT, keyPem: PEM_KEY, resolver: "le" });
  });

  it("matches a SAN, not just the main domain", () => {
    expect(certFromAcmeJson(acme([entry("a.com", ["www.a.com"])]), "www.a.com")).not.toBeNull();
  });

  it("matches a wildcard entry one label deep only", () => {
    const json = acme([entry("*.a.com")]);
    expect(certFromAcmeJson(json, "app.a.com")).not.toBeNull();
    expect(certFromAcmeJson(json, "a.com")).toBeNull();
    expect(certFromAcmeJson(json, "deep.app.a.com")).toBeNull();
  });

  it("reports which resolver the cert came from", () => {
    expect(certFromAcmeJson(acme([entry("a.com")], "myresolver"), "a.com")?.resolver).toBe(
      "myresolver",
    );
  });

  it("searches every resolver in the file", () => {
    const json = JSON.stringify({
      staging: { Certificates: [entry("other.com")] },
      prod: { Certificates: [entry("a.com")] },
    });
    expect(certFromAcmeJson(json, "a.com")?.resolver).toBe("prod");
  });

  it("tolerates lowercase `certificates` (key casing varies by version)", () => {
    const json = JSON.stringify({ le: { certificates: [entry("a.com")] } });
    expect(certFromAcmeJson(json, "a.com")).not.toBeNull();
  });

  it("returns null for a domain that isn't in the file", () => {
    expect(certFromAcmeJson(acme([entry("a.com")]), "b.com")).toBeNull();
  });

  it("returns null on malformed JSON or an empty store rather than throwing", () => {
    expect(certFromAcmeJson("not json", "a.com")).toBeNull();
    expect(certFromAcmeJson("{}", "a.com")).toBeNull();
    expect(certFromAcmeJson(acme([]), "a.com")).toBeNull();
  });

  it("rejects an entry whose base64 doesn't decode to PEM armour", () => {
    // A truncated field decodes to garbage rather than failing, so requiring the
    // armour is what stops garbage reaching the validator as if it were material.
    const bad = { domain: { main: "a.com" }, certificate: b64("nonsense"), key: b64("nope") };
    expect(certFromAcmeJson(acme([bad]), "a.com")).toBeNull();
  });
});

describe("traefikAcmeCert", () => {
  /** Executor with files on the host and/or inside the traefik container. */
  function exec(host: Record<string, string>, inContainer: Record<string, string> = {}) {
    return {
      readFile: vi.fn(async (p: string) => {
        if (host[p] === undefined) throw new Error("enoent");
        return host[p];
      }),
      exec: vi.fn(async (cmd: string) => {
        const hit = Object.entries(inContainer).find(([p]) => cmd.includes(p));
        return hit ? hit[1] : "";
      }),
    } as unknown as CommandExecutor;
  }

  it("reads the default /acme.json off the host", async () => {
    const got = await traefikAcmeCert(exec({ "/acme.json": acme([entry("a.com")]) }), "a.com");
    expect(got?.certPem).toBe(PEM_CERT);
    expect(got?.source).toContain("/acme.json");
    expect(got?.source).toContain("resolver le");
  });

  it("honours a CUSTOM storage path declared in the container's args", async () => {
    // The common compose setup mounts a volume at a custom path; guessing
    // /acme.json finds nothing there.
    const e = exec(
      {},
      {
        // `docker inspect` output carrying the storage flag…
        "--format": '["--certificatesresolvers.le.acme.storage=/letsencrypt/acme.json"]',
        // …and the file itself, inside the container.
        "/letsencrypt/acme.json": acme([entry("a.com")]),
      },
    );
    const got = await traefikAcmeCert(e, "a.com", "traefik");
    expect(got?.certPem).toBe(PEM_CERT);
    expect(got?.source).toContain("/letsencrypt/acme.json");
  });

  it("reads acme.json INSIDE the container when the host has no view of it", async () => {
    const e = exec({}, { "/acme.json": acme([entry("a.com")]) });
    expect((await traefikAcmeCert(e, "a.com", "traefik"))?.certPem).toBe(PEM_CERT);
  });

  it("returns null when there's no storage anywhere", async () => {
    expect(await traefikAcmeCert(exec({}), "a.com")).toBeNull();
  });
});
