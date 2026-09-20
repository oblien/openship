import { describe, expect, it } from "vitest";

import {
  parseDeploymentMetadata,
  vercelMetadataParser,
  railwayMetadataParser,
  renderMetadataParser,
} from "@repo/core";
import { detectStack, type RepoFile } from "@repo/platform/engine/lib/stack-detector";

function files(...names: string[]): RepoFile[] {
  return names.map((name) =>
    name.endsWith("/") ? { name: name.slice(0, -1), type: "dir" } : { name, type: "file" },
  );
}

// ─── vercel.json parser ──────────────────────────────────────────────────────

describe("vercelMetadataParser", () => {
  it("extracts local build config", () => {
    const meta = vercelMetadataParser.parse({
      "vercel.json": JSON.stringify({
        installCommand: "npm ci",
        buildCommand: "vite build",
        outputDirectory: "build",
        framework: "vite",
      }),
    });
    expect(meta).toMatchObject({
      source: "vercel",
      installCommand: "npm ci",
      buildCommand: "vite build",
      outputDirectory: "build",
      framework: "vite",
    });
    expect(meta?.nonLocal).toBeUndefined();
  });

  it("flags nonLocal when the build cd's into another directory", () => {
    const meta = vercelMetadataParser.parse({
      "vercel.json": JSON.stringify({
        installCommand: "npm install && cd frontend && npm install",
        buildCommand: "cd frontend && npm run build",
        outputDirectory: "frontend/dist",
      }),
    });
    expect(meta?.nonLocal).toBe(true);
  });

  it("does NOT flag nonLocal for a bare `cd .`", () => {
    const meta = vercelMetadataParser.parse({
      "vercel.json": JSON.stringify({ buildCommand: "cd . && npm run build" }),
    });
    expect(meta?.nonLocal).toBeUndefined();
  });

  it("captures SPA rewrites", () => {
    const meta = vercelMetadataParser.parse({
      "vercel.json": JSON.stringify({ rewrites: [{ source: "/(.*)", destination: "/index.html" }] }),
    });
    expect(meta?.rewrites).toEqual([{ source: "/(.*)", destination: "/index.html" }]);
  });

  it("returns null for invalid JSON and for an empty config", () => {
    expect(vercelMetadataParser.parse({ "vercel.json": "{not json" })).toBeNull();
    expect(vercelMetadataParser.parse({ "vercel.json": "{}" })).toBeNull();
    expect(vercelMetadataParser.parse({})).toBeNull();
  });

  it("captures the full routing config (rewrites/redirects/headers/cleanUrls/trailingSlash)", () => {
    const meta = vercelMetadataParser.parse({
      "vercel.json": JSON.stringify({
        rewrites: [{ source: "/api/(.*)", destination: "/api" }],
        redirects: [{ source: "/old", destination: "/new", permanent: true }],
        headers: [{ source: "/(.*)", headers: [{ key: "X-Frame-Options", value: "DENY" }] }],
        cleanUrls: true,
        trailingSlash: false,
      }),
    });
    expect(meta?.routing).toEqual({
      rewrites: [{ source: "/api/(.*)", destination: "/api" }],
      redirects: [{ source: "/old", destination: "/new", permanent: true }],
      headers: [{ source: "/(.*)", headers: [{ key: "X-Frame-Options", value: "DENY" }] }],
      cleanUrls: true,
      trailingSlash: false,
    });
  });

  it("routing is a signal even when there are no build fields", () => {
    const meta = vercelMetadataParser.parse({
      "vercel.json": JSON.stringify({ redirects: [{ source: "/a", destination: "/b" }] }),
    });
    expect(meta?.routing?.redirects).toEqual([{ source: "/a", destination: "/b" }]);
  });

  it("drops conditional (has/missing) rules nginx can't reproduce", () => {
    const meta = vercelMetadataParser.parse({
      "vercel.json": JSON.stringify({
        rewrites: [{ source: "/a", destination: "/b", has: [{ type: "host", value: "x.com" }] }],
      }),
    });
    expect(meta).toBeNull(); // the only rule was conditional → no usable signal
  });

  it("maps framework slugs that differ from openship stack ids", () => {
    const fw = (slug: string) =>
      vercelMetadataParser.parse({ "vercel.json": JSON.stringify({ framework: slug }) })?.framework;
    expect(fw("nuxtjs")).toBe("nuxt");
    expect(fw("create-react-app")).toBe("cra");
    expect(fw("svelte")).toBe("sveltekit");
  });
});

// ─── render.yaml parser ──────────────────────────────────────────────────────

describe("renderMetadataParser", () => {
  const RENDER = [
    "services:",
    "  - type: web",
    "    name: ems-api",
    "    buildCommand: npm install",
    "    startCommand: npm start",
    "    envVars:",
    "      - key: NODE_VERSION",
    "        value: 24",
    "      - key: MONGO_URI",
    "        sync: false",
    "",
  ].join("\n");

  it("extracts the start command as a fill-only hint", () => {
    const meta = renderMetadataParser.parse({ "render.yaml": RENDER });
    expect(meta?.source).toBe("render");
    expect(meta?.fillOnly).toBe(true);
    expect(meta?.startCommand).toBe("npm start");
  });

  it("suppresses a bare-install buildCommand (it's install, not build)", () => {
    const meta = renderMetadataParser.parse({ "render.yaml": RENDER });
    expect(meta?.buildCommand).toBeUndefined();
  });

  it("captures literal envVars and skips synced secrets", () => {
    const meta = renderMetadataParser.parse({ "render.yaml": RENDER });
    expect(meta?.env).toEqual({ NODE_VERSION: "24" });
  });

  it("handles CRLF line endings", () => {
    const meta = renderMetadataParser.parse({ "render.yaml": RENDER.replace(/\n/g, "\r\n") });
    expect(meta?.startCommand).toBe("npm start");
  });
});

// ─── railway.toml / railway.json parser ──────────────────────────────────────

describe("railwayMetadataParser", () => {
  it("extracts build + start commands from railway.toml as authoritative hints", () => {
    const meta = railwayMetadataParser.parse({
      "railway.toml": [
        "[build]",
        'builder = "NIXPACKS"',
        'buildCommand = "npm run build"',
        "",
        "[deploy]",
        'startCommand = "npm run start:prod"',
        'healthcheckPath = "/health"',
        "",
      ].join("\n"),
    });
    expect(meta).toMatchObject({
      source: "railway",
      buildCommand: "npm run build",
      startCommand: "npm run start:prod",
    });
    expect(meta?.fillOnly).toBeUndefined(); // authoritative, not fill-only
    expect(meta?.framework).toBeUndefined(); // NIXPACKS → let openship detect
  });

  it("reads railway.json (build/deploy tables)", () => {
    const meta = railwayMetadataParser.parse({
      "railway.json": JSON.stringify({
        $schema: "https://railway.com/railway.schema.json",
        build: { builder: "NIXPACKS", buildCommand: "go build -o app ." },
        deploy: { startCommand: "./app", numReplicas: 2 },
      }),
    });
    expect(meta).toMatchObject({ source: "railway", buildCommand: "go build -o app .", startCommand: "./app" });
  });

  it("maps a DOCKERFILE builder to the docker framework", () => {
    const meta = railwayMetadataParser.parse({
      "railway.toml": '[build]\nbuilder = "DOCKERFILE"\ndockerfilePath = "Dockerfile"\n',
    });
    expect(meta?.framework).toBe("docker");
  });

  it("preserves `#` and `&&` inside a quoted command (not a comment)", () => {
    const meta = railwayMetadataParser.parse({
      "railway.toml": "[deploy]\nstartCommand = \"sh -c 'echo # keep && node server.js'\"\n",
    });
    expect(meta?.startCommand).toBe("sh -c 'echo # keep && node server.js'");
  });

  it("flags nonLocal when the build cd's into another directory", () => {
    const meta = railwayMetadataParser.parse({
      "railway.toml": '[build]\nbuildCommand = "cd frontend && npm run build"\n',
    });
    expect(meta?.nonLocal).toBe(true);
  });

  it("prefers railway.toml over railway.json when both are present", () => {
    const meta = railwayMetadataParser.parse({
      "railway.toml": '[deploy]\nstartCommand = "from-toml"\n',
      "railway.json": JSON.stringify({ deploy: { startCommand: "from-json" } }),
    });
    expect(meta?.startCommand).toBe("from-toml");
  });

  it("returns null for an empty config, missing file, and invalid json", () => {
    expect(railwayMetadataParser.parse({ "railway.toml": "[deploy]\nnumReplicas = 3\n" })).toBeNull();
    expect(railwayMetadataParser.parse({})).toBeNull();
    expect(railwayMetadataParser.parse({ "railway.json": "{not json" })).toBeNull();
  });
});

// ─── railway: TOML format & quoting matrix (hand-rolled reader) ───────────────

describe("railwayMetadataParser — TOML format & quoting", () => {
  const parse = (toml: string) => railwayMetadataParser.parse({ "railway.toml": toml });

  it("reads single-quoted (literal) strings", () => {
    expect(parse("[build]\nbuildCommand = 'npm run build'\n")?.buildCommand).toBe("npm run build");
  });

  it("unescapes an escaped quote inside a basic (double-quoted) string", () => {
    expect(parse('[deploy]\nstartCommand = "echo \\"hi\\" && run"\n')?.startCommand).toBe(
      'echo "hi" && run',
    );
  });

  it("keeps backslashes literal in a single-quoted string", () => {
    expect(parse("[deploy]\nstartCommand = 'a\\b\\c'\n")?.startCommand).toBe("a\\b\\c");
  });

  it("accepts no spaces around the `=`", () => {
    expect(parse('[build]\nbuildCommand="make build"\n')?.buildCommand).toBe("make build");
  });

  it("strips an inline comment after a quoted value", () => {
    expect(parse('[build]\nbuilder = "DOCKERFILE"  # use the Dockerfile\n')?.framework).toBe("docker");
  });

  it("strips an inline comment after a bare value", () => {
    expect(parse("[build]\nbuilder = DOCKERFILE # comment\n")?.framework).toBe("docker");
  });

  it("ignores full-line comments", () => {
    expect(parse('# header\n[deploy]\nstartCommand = "x"\n')?.startCommand).toBe("x");
  });

  it("tolerates whitespace in the section header", () => {
    expect(parse('[ deploy ]\nstartCommand = "x"\n')?.startCommand).toBe("x");
  });

  it("handles CRLF line endings", () => {
    const toml = ["[build]", 'buildCommand = "a"', "[deploy]", 'startCommand = "b"', ""].join("\r\n");
    expect(parse(toml)).toMatchObject({ buildCommand: "a", startCommand: "b" });
  });

  it("strips a UTF-8 BOM", () => {
    expect(parse('﻿[deploy]\nstartCommand = "x"\n')?.startCommand).toBe("x");
  });

  it("drops an unterminated string instead of capturing garbage", () => {
    expect(parse('[deploy]\nstartCommand = "oops no close\n')).toBeNull();
  });

  it("ignores the right key under the wrong table", () => {
    expect(parse('[experimental]\nbuildCommand = "x"\nstartCommand = "y"\n')).toBeNull();
  });

  it("maps a lowercase `dockerfile` builder to the docker stack", () => {
    expect(parse('[build]\nbuilder = "dockerfile"\n')?.framework).toBe("docker");
  });

  it("does not treat NIXPACKS/RAILPACK as a framework hint", () => {
    expect(parse('[build]\nbuilder = "RAILPACK"\nbuildCommand = "x"\n')?.framework).toBeUndefined();
  });

  it("ignores nixpacksPlan/watchPatterns noise and still reads the command", () => {
    const toml = [
      "[build]",
      'builder = "NIXPACKS"',
      'buildCommand = "npm run build"',
      'watchPatterns = ["src/**", "*.ts"]',
      "",
      "[deploy]",
      'startCommand = "npm start"',
      "numReplicas = 3",
      "",
    ].join("\n");
    expect(parse(toml)).toMatchObject({ buildCommand: "npm run build", startCommand: "npm start" });
  });

  it("captures a build/start command containing decoded escapes", () => {
    expect(parse('[deploy]\nstartCommand = "a\\tb\\nc"\n')?.startCommand).toBe("a\tb\nc");
  });

  it("reads dotted keys (build.buildCommand / deploy.startCommand)", () => {
    const meta = parse('build.buildCommand = "npm run build"\ndeploy.startCommand = "node app.js"\n');
    expect(meta).toMatchObject({ buildCommand: "npm run build", startCommand: "node app.js" });
  });

  it("keeps reading a table whose header carries a trailing comment", () => {
    const meta = parse('[build]  # docker image build\nbuilder = "DOCKERFILE"\nbuildCommand = "make"\n');
    expect(meta).toMatchObject({ framework: "docker", buildCommand: "make" });
  });

  it("captures a single-line triple-quoted value", () => {
    expect(parse('[deploy]\nstartCommand = """node server.js"""\n')?.startCommand).toBe("node server.js");
  });

  it("skips a multi-line triple-quoted body without misreading it as keys", () => {
    const meta = parse(
      ['[build]', 'buildCommand = """', 'npm ci', 'builder = "DOCKERFILE"', '"""', ''].join("\n"),
    );
    // buildCommand isn't captured (multi-line), and — critically — the body line
    // that looks like `builder = "DOCKERFILE"` must NOT spuriously set docker.
    expect(meta).toBeNull();
  });
});

describe("railwayMetadataParser — railway.json edge cases", () => {
  const parse = (json: string) => railwayMetadataParser.parse({ "railway.json": json });

  it("survives null build/deploy tables", () => {
    expect(parse(JSON.stringify({ build: null, deploy: null }))).toBeNull();
  });

  it("returns null (never throws) for degenerate top-level json", () => {
    expect(parse("null")).toBeNull();
    expect(parse("123")).toBeNull();
    expect(parse("[]")).toBeNull();
    expect(parse('"just a string"')).toBeNull();
  });

  it("survives a non-object build table", () => {
    expect(
      parse(JSON.stringify({ build: "nixpacks", deploy: { startCommand: "run" } }))?.startCommand,
    ).toBe("run");
  });

  it("ignores a non-string command value", () => {
    expect(parse(JSON.stringify({ build: { buildCommand: 123 } }))).toBeNull();
  });

  it("maps a DOCKERFILE builder from json", () => {
    expect(parse(JSON.stringify({ build: { builder: "DOCKERFILE" } }))?.framework).toBe("docker");
  });

  it("falls back to railway.json when railway.toml is content-free", () => {
    const meta = railwayMetadataParser.parse({
      "railway.toml": "# only a comment\n",
      "railway.json": JSON.stringify({ deploy: { startCommand: "node app.js" } }),
    });
    expect(meta?.startCommand).toBe("node app.js");
  });
});

// ─── registry ────────────────────────────────────────────────────────────────

describe("parseDeploymentMetadata", () => {
  it("returns sources in precedence order (vercel → railway → render)", () => {
    const list = parseDeploymentMetadata({
      "vercel.json": JSON.stringify({ buildCommand: "vite build" }),
      "railway.toml": '[deploy]\nstartCommand = "node server.js"\n',
      "render.yaml": "services:\n  - type: web\n    startCommand: npm start\n",
    });
    expect(list.map((m) => m.source)).toEqual(["vercel", "railway", "render"]);
  });
});

// ─── detectStack integration ─────────────────────────────────────────────────

describe("detectStack - metadata overrides", () => {
  it("applies a self-contained vercel.json build config over detection", () => {
    const result = detectStack(
      files("package.json", "vite.config.ts"),
      {
        dependencies: { vite: "^8.0.0", react: "^19.0.0", "react-dom": "^19.0.0" },
        scripts: { build: "vite build" },
      },
      { "vercel.json": JSON.stringify({ buildCommand: "vite build --mode production", outputDirectory: "build" }) },
    );
    expect(result.stack).toBe("vite");
    expect(result.buildCommand).toBe("vite build --mode production");
    expect(result.outputDirectory).toBe("build");
  });

  it("does NOT apply a nonLocal (cd elsewhere) vercel.json to the directory it sits in", () => {
    const result = detectStack(
      files("package.json", "server.js"),
      { dependencies: { express: "^5.0.0" }, scripts: { start: "node server.js" } },
      {
        "vercel.json": JSON.stringify({
          installCommand: "npm install && cd frontend && npm install",
          buildCommand: "cd frontend && npm run build",
          outputDirectory: "frontend/dist",
        }),
      },
    );
    expect(result.stack).toBe("express");
    expect(result.buildCommand).toBe(""); // express default, not "cd frontend && ..."
    expect(result.installCommand).not.toContain("cd frontend");
    expect(result.outputDirectory).not.toBe("frontend/dist");
  });

  it("render.yaml never overrides a start command detection already resolved", () => {
    const result = detectStack(
      files("package.json", "server.js"),
      { dependencies: { express: "^5.0.0" }, scripts: { start: "node server.js" } },
      { "render.yaml": "services:\n  - type: web\n    startCommand: node OTHER.js\n" },
    );
    expect(result.startCommand).toContain("start"); // npm run start, not "node OTHER.js"
    expect(result.startCommand).not.toContain("OTHER");
  });

  it("a vercel framework hint reclassifies the stack", () => {
    const result = detectStack(
      files("package.json"),
      { dependencies: {} },
      { "vercel.json": JSON.stringify({ framework: "vite" }) },
    );
    expect(result.stack).toBe("vite");
    expect(result.category).toBe("frontend");
  });

  it("applies railway.toml's start command over detection (authoritative, unlike render)", () => {
    const result = detectStack(
      files("package.json", "server.js"),
      { dependencies: { express: "^5.0.0" }, scripts: { start: "node server.js" } },
      { "railway.toml": '[deploy]\nstartCommand = "node dist/main.js"\n' },
    );
    expect(result.stack).toBe("express");
    expect(result.startCommand).toBe("node dist/main.js");
  });

  it("reclassifies to the docker stack for a railway DOCKERFILE builder", () => {
    const result = detectStack(
      files("package.json"),
      { dependencies: {} },
      { "railway.toml": '[build]\nbuilder = "DOCKERFILE"\n' },
    );
    expect(result.stack).toBe("docker");
    expect(result.category).toBe("docker");
  });
});

// ─── Vercel "Output Directory" → static build ────────────────────────────────

describe("detectStack - static output directory classification", () => {
  it("treats an ambiguous node repo with a vercel outputDirectory as a static build", () => {
    // Webpack-style app: build → a custom output dir, a DEV `start` script, no framework preset.
    const result = detectStack(
      files("package.json", ".babelrc"),
      {
        dependencies: { react: "^15.0.0", "react-dom": "^15.0.0", redux: "^3.5.2" },
        scripts: { start: "webpack-dev-server --progress", build: "webpack --config ./webpack.production.config.js" },
      },
      { "vercel.json": JSON.stringify({ buildCommand: "npm run build", outputDirectory: "docs" }) },
    );
    expect(result.category).toBe("static");
    expect(result.outputDirectory).toBe("docs");
    expect(result.buildCommand).toBe("npm run build");
    expect(result.startCommand).toBe(""); // dev server dropped - it's a static build
  });

  it("keeps a Vite SPA static with its output directory", () => {
    const result = detectStack(
      files("package.json", "vite.config.js", "index.html"),
      {
        dependencies: { react: "^18.0.0", "react-dom": "^18.0.0", vite: "^5.0.0" },
        scripts: { build: "vite build", start: "vite --port 3000" },
      },
      { "vercel.json": JSON.stringify({ framework: "vite", outputDirectory: "dist" }) },
    );
    expect(result.stack).toBe("vite");
    expect(result.category).toBe("frontend");
    expect(result.outputDirectory).toBe("dist");
    expect(result.startCommand).toBe(""); // static SPA - no server
  });

  it("does NOT turn a genuine server framework static just because outputDirectory is set", () => {
    const result = detectStack(
      files("package.json", "next.config.js"),
      {
        dependencies: { next: "^15.0.0", react: "^19.0.0", "react-dom": "^19.0.0" },
        scripts: { build: "next build", start: "next start" },
      },
      { "vercel.json": JSON.stringify({ outputDirectory: ".next" }) },
    );
    expect(result.stack).toBe("nextjs");
    expect(result.startCommand).toContain("start"); // still a server (SSR)
  });
});
