import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildCatalog, compileAppArticle } from "../../scripts/gen-catalog";
import { appTemplateSchema, isValidAppTemplate, parseAppTemplate, templateEngineOk } from "./schema";
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

  it("embeds authored Markdown in the same published artifact as the template", () => {
    const app = getAppTemplate("convex")!;
    const compiled = compileAppArticle({
      ...app, marketplace: { features: app.marketplace?.features, articleFile: "articles/convex.md" },
    });
    expect(compiled.marketplace?.article).toBe(readFileSync(
      fileURLToPath(new URL("./catalog/articles/convex.md", import.meta.url)), "utf8",
    ).trim());
    expect(compiled.marketplace).not.toHaveProperty("articleFile");
    const { marketplace: _, ...before } = app;
    const { marketplace: __, ...after } = compiled;
    expect(after).toEqual(before);
  });

  it("rejects unsafe, missing, or ambiguous article sources", () => {
    const app = getAppTemplate("convex")!;
    for (const articleFile of ["../secret.md", "articles/../../secret.md", "/tmp/secret.md", "articles/missing-article.md"]) {
      expect(() => compileAppArticle({ ...app, marketplace: { articleFile } })).toThrow();
    }
    expect(() => compileAppArticle({ ...app, marketplace: { article: "inline", articleFile: "articles/convex.md" } })).toThrow("choose article or articleFile");
  });

  it("keeps marketplace content optional and validates new fields", () => {
    const { marketplace: _, ...legacy } = getAppTemplate("convex")!;
    expect(isValidAppTemplate(legacy)).toBe(true);
    expect(isValidAppTemplate({ ...legacy, marketplace: { features: [{ title: "Reactive data" }], article: "## Overview" } })).toBe(true);
    for (const marketplace of [
      { features: [{ title: "" }] }, { features: [{ title: "Valid", description: 1 }] },
      { article: "x".repeat(200_001) }, { articleFile: "../outside.md" },
    ]) expect(isValidAppTemplate({ ...legacy, marketplace })).toBe(false);
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
          templateEngineOk(MIN_ENGINE, app.minEngine),
          `${app.id}/${service.name} declares minEngine=${app.minEngine}, must be >= ${MIN_ENGINE}`,
        ).toBe(true);
      }
    }
  });
});

describe("published app startup", () => {
  it("gates exact entrypoint overrides so older engines cannot publish an uninitialized application", () => {
    const app = getAppTemplate("jellyfin")!;
    expect(isValidAppTemplate(app)).toBe(true);
    expect(isValidAppTemplate({ ...app, minEngine: "0.9.1" })).toBe(false);
    expect(isValidAppTemplate({ ...app, minEngine: undefined })).toBe(false);
    expect(parseAppTemplate(app, { engineVersion: "0.9.1" })).toMatchObject({ ok: false });
    expect(parseAppTemplate(app, { engineVersion: "0.9.2" })).toEqual({ ok: true });
    const cleared = {
      ...app,
      services: [{ name: "jellyfin", image: "jellyfin/jellyfin:12.2", entrypointArgv: [] }],
    };
    expect(appTemplateSchema.parse(cleared).services![0]!.entrypointArgv).toEqual([]);
  });

  it.each(["paperless-ngx", "wiki-js", "homepage", "immich", "jellyfin"])(
    "keeps %s private dependencies and secrets out of public setup",
    (id) => {
      const app = getAppTemplate(id)!;
      expect(app.services!.every((service) => service.image && !service.build)).toBe(true);
      for (const endpoint of app.endpoints ?? []) {
        if (endpoint.kind === "tcp")
          expect(endpoint).toMatchObject({ scope: "internal", allowedModes: ["internal"] });
      }
      for (const service of app.services!) {
        expect(service.volumes?.some((volume) => /docker\.sock|^\/:/.test(volume))).not.toBe(true);
        for (const field of app.configFields ?? []) {
          if (field.service === service.name && field.generate === "secret") {
            expect(field.secret).toBe(true);
            expect(service.secretEnv).toContain(field.key);
          }
        }
      }
    },
  );
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
  it("accepts explicit resource profiles and rejects unlimited or malformed allocations", () => {
    const resources = { cpuCores: 0.25, memoryMb: 256, diskMb: 8192 };
    const profile = (value: unknown) => ({
      ...base,
      services: [{ ...base.services[0], resources: value }],
    });
    expect(appTemplateSchema.parse(profile(resources)).services![0]!.resources).toEqual(resources);
    const swapDisabled = { ...resources, swapDisabled: true };
    expect(appTemplateSchema.parse(profile(swapDisabled)).services![0]!.resources).toEqual(
      swapDisabled,
    );
    for (const invalid of [
      { ...resources, cpuCores: 0 },
      { ...resources, memoryMb: 64 },
      { ...resources, diskMb: "8192" },
      { ...resources, privileged: true },
      { cpuCores: 1, memoryMb: 1024 },
    ])
      expect(isValidAppTemplate(profile(invalid))).toBe(false);
  });
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
  it.each(["single", "split", "grouped"])("preserves %s form layout metadata when parsing a catalog entry", (settings) => {
    const template = {
      ...base,
      installLayout: { settings, columns: 2 },
      settings: [
        {
          id: "general",
          label: "General",
          columns: 1,
          fields: [{ key: "NOTE", service: "db", label: "Note", type: "textarea", fullWidth: true }],
        },
      ],
    };
    expect(appTemplateSchema.parse(template)).toEqual(template);
  });

  it.each([
    { installLayout: { settings: "flex" } },
    { installLayout: { columns: 2 } },
    { installLayout: { settings: "single", columns: 3 } },
    { settings: [{ id: "g", label: "G", columns: "2", fields: [] }] },
    {
      settings: [
        {
          id: "g",
          label: "G",
          fields: [{ key: "NOTE", service: "db", label: "Note", type: "text", fullWidth: "true" }],
        },
      ],
    },
  ])("rejects malformed form layout metadata: %j", (layout) => {
    expect(isValidAppTemplate({ ...base, ...layout })).toBe(false);
  });

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
