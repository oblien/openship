import { describe, it, expect } from "vitest";
import { isValidAppTemplate, parseAppTemplate, MAX_SUPPORTED_SCHEMA } from "./schema";
import { INSTALL_PHASES } from "./install-phases";
import { getAppTemplate, getAppFirstLogin, getAppPrepareSteps } from "../app-templates";

// Minimal valid template, mirrors catalog.test.ts.
const base = {
  id: "t",
  name: "T",
  description: "d",
  kind: "template",
  logo: "t",
  category: "database",
  services: [{ name: "db", image: "postgres:16" }],
} as const;

describe("install-phase backbone", () => {
  it("is the canonical, ordered phase list", () => {
    expect(INSTALL_PHASES.map((p) => p.id)).toEqual(["images", "services", "app-setup", "ready"]);
  });
  it("every phase ships a default label", () => {
    for (const p of INSTALL_PHASES) expect(p.defaultLabel.length).toBeGreaterThan(0);
  });
});

describe("authored install copy is additive (no schemaVersion bump)", () => {
  it("the supported schema version stays at 1", () => {
    expect(MAX_SUPPORTED_SCHEMA).toBe(1);
  });

  it("accepts prepareStep title/description/icon (localized) with no version set", () => {
    const tpl = {
      ...base,
      prepare: [
        {
          service: "db",
          command: "echo hi",
          capture: "x",
          title: { en: "Generate key", tr: "Anahtar üret" },
          description: "Mint the admin key.",
          icon: "key",
        },
      ],
    };
    expect(isValidAppTemplate(tpl)).toBe(true);
    expect(parseAppTemplate(tpl)).toEqual({ ok: true });
  });

  it("accepts connection.firstLogin (localized) with no version set", () => {
    const tpl = {
      ...base,
      connection: {
        outputs: [{ id: "url", label: "U", source: "env:db:URL" }],
        firstLogin: { username: "admin", password: "admin", note: { en: "Change it." } },
      },
    };
    expect(isValidAppTemplate(tpl)).toBe(true);
    expect(parseAppTemplate(tpl)).toEqual({ ok: true });
  });

  it("still parses when the author pins schemaVersion 1 alongside the new copy", () => {
    const tpl = {
      ...base,
      schemaVersion: 1,
      prepare: [{ service: "db", command: "echo", capture: "x", icon: "key" }],
      connection: {
        outputs: [{ id: "url", label: "U", source: "env:db:URL" }],
        firstLogin: { username: "admin", password: "admin" },
      },
    };
    expect(parseAppTemplate(tpl)).toEqual({ ok: true });
  });
});

describe("connection output `kind` is additive (no schemaVersion bump)", () => {
  it("accepts a url-kind output", () => {
    const tpl = {
      ...base,
      connection: { outputs: [{ id: "ui", label: "UI", source: "publicUrl:db", kind: "url" }] },
    };
    expect(isValidAppTemplate(tpl)).toBe(true);
    expect(parseAppTemplate(tpl)).toEqual({ ok: true });
  });

  it("accepts an explicit text-kind output", () => {
    const tpl = {
      ...base,
      connection: { outputs: [{ id: "u", label: "U", source: "env:db:URL", kind: "text" }] },
    };
    expect(parseAppTemplate(tpl)).toEqual({ ok: true });
  });

  it("rejects an unknown kind", () => {
    const tpl = {
      ...base,
      connection: { outputs: [{ id: "u", label: "U", source: "env:db:URL", kind: "link" }] },
    };
    expect(isValidAppTemplate(tpl)).toBe(false);
  });
});

describe("bundled catalog marks only browser-openable outputs `kind:url`", () => {
  it("Qdrant: the Web UI is openable, the REST API is not", () => {
    const outs = getAppTemplate("qdrant")?.connection?.outputs ?? [];
    expect(outs.find((o) => o.id === "ui")?.kind).toBe("url");
    expect(outs.find((o) => o.id === "restUrl")?.kind).toBeUndefined();
  });

  it("MinIO: the console is openable, the S3 API endpoint is not", () => {
    const outs = getAppTemplate("minio")?.connection?.outputs ?? [];
    expect(outs.find((o) => o.id === "console")?.kind).toBe("url");
    expect(outs.find((o) => o.id === "endpoint")?.kind).toBeUndefined();
  });
});

describe("authored copy accessors on the bundled catalog", () => {
  it("Grafana surfaces its static admin/admin first login", () => {
    const g = getAppTemplate("grafana");
    expect(g).toBeDefined();
    const fl = getAppFirstLogin(g!);
    expect(fl?.username).toBe("admin");
    expect(fl?.password).toBe("admin");
    expect(fl?.note).toBeTruthy();
  });

  it("Grafana (pull-only) declares no prepare steps", () => {
    const g = getAppTemplate("grafana");
    expect(getAppPrepareSteps(g!)).toEqual([]);
  });

  it("Convex's admin-key prepare step carries authored title/description/icon", () => {
    const c = getAppTemplate("convex");
    expect(c).toBeDefined();
    const steps = getAppPrepareSteps(c!);
    expect(steps.length).toBeGreaterThan(0);
    const step = steps[0];
    expect(step.capture).toBe("adminKey");
    expect(step.icon).toBe("key");
    expect(step.title).toBeTruthy();
    expect(step.description).toBeTruthy();
  });

  it("an app that declares no first login returns null", () => {
    expect(getAppFirstLogin(base as never)).toBeNull();
  });
});
