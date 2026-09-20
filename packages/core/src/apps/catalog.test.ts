import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildCatalog } from "../../scripts/gen-catalog";
import { isValidAppTemplate, parseAppTemplate, templateEngineOk } from "./schema";
import { APP_TEMPLATES, getAppTemplate } from "../app-templates";

const committed = JSON.parse(
  readFileSync(fileURLToPath(new URL("./catalog.json", import.meta.url)), "utf8"),
);

describe("app catalog (JSON)", () => {
  it("catalog.json is in sync with apps/catalog/*.json (run `bun scripts/gen-catalog.ts`)", () => {
    expect(buildCatalog()).toEqual(committed);
  });

  it("every bundled app validates against the shape schema", () => {
    for (const app of APP_TEMPLATES) {
      expect(isValidAppTemplate(app), `${app.id} failed schema`).toBe(true);
    }
  });

  it("keeps Supabase's advertised SAML endpoints on its public Kong routes", () => {
    const supabase = getAppTemplate("supabase");
    const samlBase = supabase?.services?.find((service) => service.name === "auth")?.environment
      ?.GOTRUE_SAML_EXTERNAL_URL;
    const kongConfig = supabase?.files?.find(
      (file) => file.service === "kong" && file.path === "/usr/local/kong/kong.yml",
    )?.content;

    expect(samlBase).toBe("{{publicUrl:kong}}/auth/v1");
    const routePrefix = samlBase?.replace("{{publicUrl:kong}}", "");
    expect(kongConfig).toContain(`- ${routePrefix}/sso/saml/acs`);
    expect(kongConfig).toContain(`- ${routePrefix}/sso/saml/metadata`);
  });

  it("rejects a malformed template (missing required fields)", () => {
    expect(isValidAppTemplate({ id: "x" })).toBe(false);
    expect(isValidAppTemplate(null)).toBe(false);
    expect(isValidAppTemplate({ id: "x", name: "X", description: "d", kind: "template", logo: "x", category: "bogus" })).toBe(false);
  });

  it("every entry that uses commandArgv/stopGracePeriod declares minEngine >= 0.6.6 (issue #599)", () => {
    // `commandArgv` and `stopGracePeriod` were added to the serviceSpec schema
    // in commit 550fe22f, released as v0.6.6. Without minEngine >= 0.6.6 on the
    // entry, the engine-gate cannot refuse to install the app on a pre-0.6.6
    // engine — the install silently drops the field and the container runs the
    // wrong role (PostHog worker, MinIO "sh is not a minio sub-command", …).
    const MIN_ENGINE = "0.6.6";
    for (const app of APP_TEMPLATES) {
      for (const service of app.services ?? []) {
        const usesPostRelease =
          service.commandArgv !== undefined || service.stopGracePeriod !== undefined;
        if (!usesPostRelease) continue;
        expect(
          app.minEngine,
          `${app.id}/${service.name} uses a post-0.6.6 serviceSpec field but entry has no minEngine — engine gate cannot refuse pre-0.6.6 installs`,
        ).toBeDefined();
        expect(
          templateEngineOk(app.minEngine, MIN_ENGINE),
          `${app.id}/${service.name} declares minEngine=${app.minEngine}, must be >= ${MIN_ENGINE}`,
        ).toBe(true);
      }
    }
  });
});

describe("mail has exactly one entry point in the catalog", () => {
  /**
   * Openship Mail and Openship Webmail used to be two cards with the same logo,
   * the same category and overlapping copy — the mail wizard's "connect existing"
   * branch installs the webmail app, so one of them was a subset of the other. The
   * wizard is now the single door; webmail keeps its id and stays installable.
   */
  const listed = APP_TEMPLATES.filter((t) => !t.unlisted);

  it("puts Openship Mail first", () => {
    expect(listed[0]?.id).toBe("mail");
  });

  it("lists no second Openship-branded mail card", () => {
    const own = listed.filter((t) => t.category === "mail" && /^Openship /.test(t.name));
    expect(own.map((t) => t.id)).toEqual(["mail"]);
  });

  it("keeps webmail installable, just unlisted", () => {
    const webmail = APP_TEMPLATES.find((t) => t.id === "webmail");
    // `available: false` would make installApp throw "app-not-available" and break
    // the wizard's connect-existing branch. Unlisting must not become a refusal.
    expect(webmail).toMatchObject({ unlisted: true, available: true });
  });
});

// A minimal valid template used to probe the stricter, version-aware gate.
const base = {
  id: "t",
  name: "T",
  description: "d",
  kind: "template",
  logo: "t",
  category: "database",
  services: [{ name: "db", image: "postgres:16" }],
} as const;

describe("app template — versioning + engine gate (parseAppTemplate)", () => {
  it("accepts a well-formed entry (no version/engine constraints)", () => {
    expect(parseAppTemplate(base, { engineVersion: "0.3.0" })).toEqual({ ok: true });
  });

  it("drops an entry authored for a newer schemaVersion", () => {
    const r = parseAppTemplate({ ...base, schemaVersion: 999 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("schema-too-new");
  });

  it("drops an entry needing a newer engine", () => {
    const r = parseAppTemplate({ ...base, minEngine: "999.0.0" }, { engineVersion: "0.3.0" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("engine-too-new");
  });

  it("allows minEngine when the engine is new enough", () => {
    expect(parseAppTemplate({ ...base, minEngine: "0.1.0" }, { engineVersion: "0.3.0" })).toEqual({ ok: true });
  });
});

describe("templateEngineOk", () => {
  it("is ok when there's no minEngine or no known engine", () => {
    expect(templateEngineOk(undefined, "0.3.0")).toBe(true);
    expect(templateEngineOk("9.9.9", undefined)).toBe(true);
  });
  it("is ok when the engine is at or above minEngine", () => {
    expect(templateEngineOk("0.3.0", "0.3.0")).toBe(true);
    expect(templateEngineOk("0.1.0", "0.3.0")).toBe(true);
  });
  it("is NOT ok when the engine is below minEngine", () => {
    expect(templateEngineOk("0.5.0", "0.3.0")).toBe(false);
    expect(templateEngineOk("1.0.0", "0.9.9")).toBe(false);
  });
});

describe("app template — strict fields + referential integrity", () => {
  it("accepts the extended setting field types", () => {
    expect(
      isValidAppTemplate({
        ...base,
        settings: [
          {
            id: "g",
            label: "G",
            fields: [
              { key: "MODE", service: "db", label: "Mode", type: "radio", options: [{ value: "a", label: "A" }] },
              { key: "TAGS", service: "db", label: "Tags", type: "multiselect", options: [{ value: "x", label: "X" }] },
              { key: "NOTE", service: "db", label: "Note", type: "textarea" },
            ],
          },
        ],
      }),
    ).toBe(true);
  });

  it("rejects an unknown setting field type", () => {
    expect(
      isValidAppTemplate({
        ...base,
        settings: [{ id: "g", label: "G", fields: [{ key: "K", service: "db", label: "L", type: "bogus" }] }],
      }),
    ).toBe(false);
  });

  it("rejects a dangling service reference (endpoint)", () => {
    expect(isValidAppTemplate({ ...base, endpoints: [{ service: "nope", port: 5432, label: "DB", kind: "tcp" }] })).toBe(false);
  });

  it("rejects a malformed connection output source", () => {
    expect(
      isValidAppTemplate({ ...base, connection: { outputs: [{ id: "a", label: "A", source: "not-a-source" }] } }),
    ).toBe(false);
  });

  it("rejects a non-internal flowHref", () => {
    expect(isValidAppTemplate({ ...base, kind: "flow", flowHref: "https://evil.example" })).toBe(false);
    expect(isValidAppTemplate({ ...base, kind: "flow", flowHref: "/emails" })).toBe(true);
  });

  it("rejects provides that reference an unknown output", () => {
    expect(
      isValidAppTemplate({
        ...base,
        connection: { outputs: [{ id: "url", label: "U", source: "env:db:URL" }] },
        provides: [{ id: "p", outputRefs: ["missing"] }],
      }),
    ).toBe(false);
  });

  it("accepts provides that reference a real output", () => {
    expect(
      isValidAppTemplate({
        ...base,
        connection: { outputs: [{ id: "url", label: "U", source: "env:db:URL" }] },
        provides: [{ id: "p", outputRefs: ["url"], category: "database" }],
      }),
    ).toBe(true);
  });

  it("accepts output variants + half width", () => {
    expect(
      isValidAppTemplate({
        ...base,
        connection: {
          outputs: [
            {
              id: "url",
              label: "U",
              source: "env:db:URL",
              width: "half",
              sourceLabel: "Public",
              variants: [{ id: "internal", label: "Internal", source: "template:mongodb://root@db:27017/" }],
            },
          ],
        },
      }),
    ).toBe(true);
  });

  it("rejects a variant with a malformed source", () => {
    expect(
      isValidAppTemplate({
        ...base,
        connection: {
          outputs: [
            { id: "url", label: "U", source: "env:db:URL", variants: [{ id: "bad", label: "Bad", source: "nope" }] },
          ],
        },
      }),
    ).toBe(false);
  });

  it("rejects a variant referencing an unknown service", () => {
    expect(
      isValidAppTemplate({
        ...base,
        connection: {
          outputs: [
            { id: "url", label: "U", source: "env:db:URL", variants: [{ id: "x", label: "X", source: "env:nope:KEY" }] },
          ],
        },
      }),
    ).toBe(false);
  });

  it("accepts a service with an inline build context (no image)", () => {
    expect(
      isValidAppTemplate({
        ...base,
        services: [
          {
            name: "compute",
            build: {
              dockerfile: "FROM alpine:3.20\nENTRYPOINT [\"/bin/sh\"]\n",
              files: [{ path: "run.sh", content: "echo hi" }],
            },
          },
        ],
      }),
    ).toBe(true);
  });

  it("rejects a service that sets BOTH image and build", () => {
    expect(
      isValidAppTemplate({
        ...base,
        services: [{ name: "db", image: "postgres:16", build: { dockerfile: "FROM postgres:16" } }],
      }),
    ).toBe(false);
  });

  it("rejects a service that sets NEITHER image nor build", () => {
    expect(isValidAppTemplate({ ...base, services: [{ name: "db" }] })).toBe(false);
  });
});
