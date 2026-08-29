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

describe("inline service build context is additive (no schemaVersion bump)", () => {
  it("accepts a built service (build instead of image) at schemaVersion 1", () => {
    const tpl = {
      ...base,
      services: [
        {
          name: "compute",
          build: {
            dockerfile: "FROM alpine:3.20\nARG TOKEN\nENTRYPOINT [\"/bin/sh\"]\n",
            files: [{ path: "run.sh", content: "echo {{config:TOKEN}}" }],
          },
        },
      ],
      schemaVersion: 1,
    };
    expect(isValidAppTemplate(tpl)).toBe(true);
    expect(parseAppTemplate(tpl)).toEqual({ ok: true });
  });
});

describe("Neon ships as one bundle with a console AND a connection", () => {
  // No bundled app uses an inline build any more (Neon was the last, and it is
  // now a single prebuilt control-plane container). The build path stays covered
  // by the synthetic template above; what has to stay pinned here is that Neon
  // is not headless — the whole point of the app is that it hands back a UI to
  // open and a Postgres URL to connect with.
  it("is a single service that routes its console", () => {
    const neon = getAppTemplate("neon");
    expect(neon).toBeDefined();
    expect(neon!.kind).toBe("template");
    // No longer badged experimental: it was booted end to end — console served,
    // bootstrap ran at the earliest install timing, and the advertised URL
    // reached Postgres. Absent `hosting` defaults to "self-hosted".
    expect(neon!.hosting).toBeUndefined();
    // But NOT `verified`, which means official image + reviewed pipeline. neond
    // is a single-maintainer community control plane whose image build workflow
    // was deleted from its repo, so its provenance is unreviewable no matter how
    // well it runs. "We tested it" and "we vouch for the publisher" are separate
    // claims and only the first one is true here.
    expect(neon!.verified).toBe(false);
    expect(neon!.services).toHaveLength(1);
    const svc = neon!.services![0];
    expect(svc.name).toBe("neond");
    expect(svc.image).toContain("neond/neond:");
    expect(svc.exposed).toBe(true);
    expect(svc.routes?.some((r) => r.port === 3000)).toBe(true);
  });

  it("survives a redeploy: a clean shutdown releases the boot lock", () => {
    // neond's boot lease is a lockfile, not an flock, so a SIGKILL at Docker's
    // 10s default leaves it behind and every later boot refuses to start.
    const svc = getAppTemplate("neon")!.services![0];
    expect(svc.stopGracePeriod).toBeTruthy();
  });

  it("publishes both a console URL and a usable database URL", () => {
    const outputs = getAppTemplate("neon")!.connection?.outputs ?? [];
    const console_ = outputs.find((o) => o.id === "console");
    expect(console_?.source).toBe("publicUrl:neond");
    expect(console_?.kind).toBe("url");
    const db = outputs.find((o) => o.id === "dbUrl");
    expect(db?.secret).toBe(true);
    // The endpoint port is assigned at runtime, so the URL is only correct if it
    // reads the port the bootstrap step captured rather than hardcoding one.
    expect(db?.source).toContain("{{env:neond:NEOND_PG_PORT}}");
  });

  it("bootstraps the admin account so the console is not an empty signup form", () => {
    const step = (getAppTemplate("neon")!.prepare ?? []).find((p) => p.capture === "pgPort");
    expect(step).toBeDefined();
    expect(step!.service).toBe("neond");
    expect(step!.phase).toBe("post-ready");
    // Registration is only open while zero users exist, so this must not fail a
    // redeploy once it has already run.
    expect(step!.mustSucceed).toBeFalsy();
    expect(step!.persistAs?.key).toBe("NEOND_PG_PORT");
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
