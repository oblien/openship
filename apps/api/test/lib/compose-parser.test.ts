import { describe, expect, it } from "vitest";
import { parseComposeEnvFile, parseComposeFile } from "../../src/lib/compose-parser";

describe("parseComposeFile", () => {
  it("resolves Docker Compose environment interpolation from .env content", () => {
    const parsed = parseComposeFile(
      `
services:
  app:
    image: node:\${NODE_VERSION:-22}
    environment:
      BETTER_AUTH_SECRET: \${BETTER_AUTH_SECRET:-change-me-in-production}
      DATABASE_URL: postgres://\${POSTGRES_USER:-postgres}:\${POSTGRES_PASSWORD:-postgres}@db:5432/app
      EMPTY_DEFAULT: \${EMPTY_VALUE:-fallback}
      EMPTY_NO_COLON: \${EMPTY_VALUE-fallback}
`,
      {
        envFileContent: `
NODE_VERSION=20
BETTER_AUTH_SECRET=from-env
POSTGRES_USER=openship
POSTGRES_PASSWORD=secret
EMPTY_VALUE=
`,
      },
    );

    expect(parsed.services[0]?.image).toBe("node:20");
    expect(parsed.services[0]?.environment).toEqual({
      BETTER_AUTH_SECRET: "from-env",
      DATABASE_URL: "postgres://openship:secret@db:5432/app",
      EMPTY_DEFAULT: "fallback",
      EMPTY_NO_COLON: "",
    });
    expect(parsed.services[0]?.environmentMeta?.BETTER_AUTH_SECRET).toMatchObject({
      source: "env-file",
      variable: "BETTER_AUTH_SECRET",
      resolvedValue: "from-env",
    });
    expect(parsed.services[0]?.environmentMeta?.EMPTY_DEFAULT).toMatchObject({
      source: "default",
      variable: "EMPTY_VALUE",
      defaultValue: "fallback",
      resolvedValue: "fallback",
    });
  });

  it("uses compose defaults when .env does not define the variable", () => {
    const parsed = parseComposeFile(`
services:
  app:
    environment:
      BETTER_AUTH_SECRET: \${BETTER_AUTH_SECRET:-change-me-in-production}
      GOOGLE_GENERATIVE_AI_API_KEY: \${GOOGLE_GENERATIVE_AI_API_KEY}
      GEMINI_MODEL: \${GEMINI_MODEL:-gemini-2.5-flash}
      PLAIN_MISSING: \${PLAIN_MISSING}
`);

    expect(parsed.services[0]?.environment).toEqual({
      BETTER_AUTH_SECRET: "change-me-in-production",
      GOOGLE_GENERATIVE_AI_API_KEY: "",
      GEMINI_MODEL: "gemini-2.5-flash",
      PLAIN_MISSING: "",
    });
    expect(parsed.services[0]?.environmentMeta?.BETTER_AUTH_SECRET).toMatchObject({
      source: "default",
      variable: "BETTER_AUTH_SECRET",
      defaultValue: "change-me-in-production",
      resolvedValue: "change-me-in-production",
    });
    expect(parsed.services[0]?.environmentMeta?.PLAIN_MISSING).toMatchObject({
      source: "missing",
      variable: "PLAIN_MISSING",
      resolvedValue: "",
    });
    expect(parsed.services[0]?.environmentMeta?.GOOGLE_GENERATIVE_AI_API_KEY).toMatchObject({
      source: "missing",
      variable: "GOOGLE_GENERATIVE_AI_API_KEY",
      resolvedValue: "",
    });
    expect(parsed.services[0]?.environmentMeta?.GEMINI_MODEL).toMatchObject({
      source: "default",
      variable: "GEMINI_MODEL",
      defaultValue: "gemini-2.5-flash",
      resolvedValue: "gemini-2.5-flash",
    });
  });

  it("supports array env form and bare keys loaded from .env", () => {
    const parsed = parseComposeFile(
      `
services:
  app:
    environment:
      - BETTER_AUTH_SECRET
      - NODE_ENV=\${NODE_ENV:-production}
`,
      {
        envFileContent: `
BETTER_AUTH_SECRET=from-env
NODE_ENV=development
`,
      },
    );

    expect(parsed.services[0]?.environment).toEqual({
      BETTER_AUTH_SECRET: "from-env",
      NODE_ENV: "development",
    });
    expect(parsed.services[0]?.environmentMeta?.BETTER_AUTH_SECRET).toMatchObject({
      source: "env-file",
      variable: "BETTER_AUTH_SECRET",
      resolvedValue: "from-env",
    });
  });

  it("keeps escaped dollars literal", () => {
    const parsed = parseComposeFile(`
services:
  app:
    command: echo $$BETTER_AUTH_SECRET
    environment:
      LITERAL: $$BETTER_AUTH_SECRET
`);

    expect(parsed.services[0]?.command).toBe("echo $BETTER_AUTH_SECRET");
    expect(parsed.services[0]?.environment.LITERAL).toBe("$BETTER_AUTH_SECRET");
  });

  it("does not re-interpolate a '$' inside a resolved value embedded in a larger string", () => {
    const parsed = parseComposeFile(
      `
services:
  app:
    environment:
      DIRECT: \${DB_PASS}
      EMBEDDED: postgres://user:\${DB_PASS}@db:5432/app
`,
      { envFileContent: `DB_PASS='p$ss'\n` },
    );

    expect(parsed.services[0]?.environment).toEqual({
      DIRECT: "p$ss",
      EMBEDDED: "postgres://user:p$ss@db:5432/app",
    });
  });
});

// ─── parseComposeEnvFile - direct .env content scenarios ─────────────────────

describe("parseComposeEnvFile - quoting, escapes, comments, edge cases", () => {
  it("parses simple KEY=value lines", () => {
    expect(parseComposeEnvFile("FOO=bar\nBAZ=qux\n")).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("ignores blank lines and comments", () => {
    expect(parseComposeEnvFile(`
# A leading comment
FOO=bar

  # An indented comment
BAZ=qux
`)).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("strips trailing inline comments outside quotes", () => {
    expect(parseComposeEnvFile(`URL=https://example.com   # the api`)).toEqual({
      URL: "https://example.com",
    });
  });

  it("preserves '#' inside double-quoted values", () => {
    expect(parseComposeEnvFile(`PWD="p@ss#word"`)).toEqual({ PWD: "p@ss#word" });
  });

  it("preserves '#' inside single-quoted values (no escape processing)", () => {
    expect(parseComposeEnvFile(`PWD='p@ss#word'`)).toEqual({ PWD: "p@ss#word" });
  });

  it("decodes common escape sequences inside double-quoted values", () => {
    expect(parseComposeEnvFile(`MSG="line1\\nline2\\ttab"`)).toEqual({
      MSG: "line1\nline2\ttab",
    });
  });

  it("does NOT process escapes inside single-quoted values", () => {
    expect(parseComposeEnvFile(`MSG='line1\\nline2'`)).toEqual({ MSG: "line1\\nline2" });
  });

  it("treats an escaped backslash as a literal `\\` before the next char", () => {
    expect(parseComposeEnvFile(String.raw`WINPATH="C:\\nginx\\conf"`)).toEqual({
      WINPATH: "C:\\nginx\\conf",
    });
    expect(parseComposeEnvFile(String.raw`X="a\\nb"`)).toEqual({ X: "a\\nb" });
    expect(parseComposeEnvFile(String.raw`Y="a\nb"`)).toEqual({ Y: "a\nb" });
  });

  it("accepts 'export' prefix (POSIX shell convention)", () => {
    expect(parseComposeEnvFile(`export FOO=bar\nexport BAZ="qux qux"`)).toEqual({
      FOO: "bar",
      BAZ: "qux qux",
    });
  });

  it("strips UTF-8 BOM from the start of the file", () => {
    expect(parseComposeEnvFile(`﻿FOO=bar`)).toEqual({ FOO: "bar" });
  });

  it("rejects keys that don't start with a letter or underscore", () => {
    // POSIX env var rules: must start with [A-Za-z_], rest [A-Za-z0-9_].
    expect(parseComposeEnvFile(`9FOO=bar\nFOO-BAR=baz\nfoo bar=baz`)).toEqual({});
  });

  it("accepts keys starting with underscore", () => {
    expect(parseComposeEnvFile(`_PRIVATE=val\n__DOUBLE=val`)).toEqual({
      _PRIVATE: "val",
      __DOUBLE: "val",
    });
  });

  it("treats empty values as empty strings, not missing", () => {
    expect(parseComposeEnvFile(`EMPTY=\nFOO=bar`)).toEqual({ EMPTY: "", FOO: "bar" });
  });

  it("interpolates ${VAR} between entries (second uses the first)", () => {
    expect(parseComposeEnvFile(`BASE=foo\nFULL=\${BASE}-bar`)).toEqual({
      BASE: "foo",
      FULL: "foo-bar",
    });
  });

  it("interpolates $VAR (bare) between entries", () => {
    expect(parseComposeEnvFile(`BASE=foo\nFULL=$BASE-bar`)).toEqual({
      BASE: "foo",
      FULL: "foo-bar",
    });
  });

  it("does NOT interpolate inside single-quoted values (literal)", () => {
    expect(parseComposeEnvFile(`BASE=foo\nA='$BASE-bar'\nB='\${BASE}-bar'`)).toEqual({
      BASE: "foo",
      A: "$BASE-bar",
      B: "${BASE}-bar",
    });
  });

  it("does not re-interpolate a literal '$' carried in by an interpolated entry", () => {
    expect(parseComposeEnvFile(`PW='a$bc'\nURL=x\${PW}y`)).toEqual({
      PW: "a$bc",
      URL: "xa$bcy",
    });
  });

  it("keeps '$$' literal inside single-quoted values (no un-escaping)", () => {
    expect(parseComposeEnvFile(`PWD='p@$$w0rd'`)).toEqual({ PWD: "p@$$w0rd" });
  });

  it("handles CRLF line endings", () => {
    expect(parseComposeEnvFile("FOO=bar\r\nBAZ=qux\r\n")).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("ignores lines without '=' (no implicit value-from-env)", () => {
    expect(parseComposeEnvFile(`SOLO_KEY\nFOO=bar`)).toEqual({ FOO: "bar" });
  });

  it("trims whitespace around keys but preserves intentional value content", () => {
    expect(parseComposeEnvFile(`  KEY  =  value with trailing\nNEXT=ok`)).toEqual({
      KEY: "value with trailing",
      NEXT: "ok",
    });
  });

  it("returns empty object for empty or whitespace-only input", () => {
    expect(parseComposeEnvFile("")).toEqual({});
    expect(parseComposeEnvFile("\n\n   \n")).toEqual({});
  });

  it("realistic project .env - database, secrets, runtime config", () => {
    const result = parseComposeEnvFile(`
# Database
DATABASE_URL=postgres://user:pass@db:5432/app
DATABASE_POOL_SIZE=20

# Auth secrets - change in production
SESSION_SECRET="a-long-random-string-with-special-#chars"
JWT_PRIVATE_KEY='-----BEGIN PRIVATE KEY-----\\nAB...XY=='

# Runtime
NODE_ENV=production
LOG_LEVEL=info
PORT=4000
`);
    expect(result.DATABASE_URL).toBe("postgres://user:pass@db:5432/app");
    expect(result.DATABASE_POOL_SIZE).toBe("20");
    expect(result.SESSION_SECRET).toBe("a-long-random-string-with-special-#chars");
    expect(result.JWT_PRIVATE_KEY).toBe("-----BEGIN PRIVATE KEY-----\\nAB...XY==");
    expect(result.NODE_ENV).toBe("production");
    expect(result.PORT).toBe("4000");
  });
});

// ─── parseComposeFile - service surface area we rely on ──────────────────────

describe("parseComposeFile - service shape extraction", () => {
  it("extracts build context and dockerfile paths", () => {
    const parsed = parseComposeFile(`
services:
  api:
    build:
      context: ./services/api
      dockerfile: Dockerfile.prod
  worker:
    build: ./services/worker
`);
    expect(parsed.services).toHaveLength(2);
    const api = parsed.services.find((s) => s.name === "api");
    const worker = parsed.services.find((s) => s.name === "worker");
    expect(api?.build).toBe("./services/api");
    expect(api?.dockerfile).toBe("Dockerfile.prod");
    expect(worker?.build).toBe("./services/worker");
  });

  it("extracts image-only services (no build, just image)", () => {
    const parsed = parseComposeFile(`
services:
  cache:
    image: redis:7-alpine
  db:
    image: postgres:16
    environment:
      POSTGRES_DB: app
`);
    const cache = parsed.services.find((s) => s.name === "cache");
    const db = parsed.services.find((s) => s.name === "db");
    expect(cache?.image).toBe("redis:7-alpine");
    expect(cache?.build).toBeUndefined();
    expect(db?.image).toBe("postgres:16");
    expect(db?.environment).toEqual({ POSTGRES_DB: "app" });
  });

  it("extracts ports in short syntax (HOST:CONTAINER)", () => {
    const parsed = parseComposeFile(`
services:
  web:
    image: nginx
    ports:
      - "80:80"
      - "443:443"
`);
    expect(parsed.services[0]?.ports).toEqual(["80:80", "443:443"]);
  });

  it("folds long-form `host_ip` into the leading `<ip>:` (loopback publish stays private)", () => {
    const parsed = parseComposeFile(`
services:
  db:
    image: postgres
    ports:
      - target: 5432
        host_ip: 127.0.0.1
        published: 5432
      - target: 80
        host_ip: 127.0.0.1
        published: 8080
        protocol: tcp
`);
    // Dropping host_ip would collapse these to "5432:5432" / "8080:80", which
    // bind 0.0.0.0 — publishing to the whole internet a service the config
    // pinned to loopback. The ip must survive as the leading short-form segment
    // that the docker runtime honors ("127.0.0.1:8080:80").
    expect(parsed.services[0]?.ports).toEqual(["127.0.0.1:5432:5432", "127.0.0.1:8080:80"]);
  });

  it("keeps host_ip when published is omitted, and omits it when absent", () => {
    const parsed = parseComposeFile(`
services:
  x:
    image: nginx
    ports:
      - target: 80
        host_ip: 127.0.0.1
      - target: 443
        published: 8443
      - target: 53
        host_ip: 0.0.0.0
        published: 53
        protocol: udp
`);
    // host_ip with no published → ip-scoped random host port ("127.0.0.1::80");
    // published with no host_ip → unchanged; protocol suffix still applies.
    expect(parsed.services[0]?.ports).toEqual(["127.0.0.1::80", "8443:443", "0.0.0.0:53:53/udp"]);
  });

  it("extracts depends_on as array", () => {
    const parsed = parseComposeFile(`
services:
  api:
    image: myorg/api
    depends_on:
      - db
      - cache
`);
    expect(parsed.services[0]?.dependsOn).toEqual(["db", "cache"]);
  });

  it("extracts restart policy", () => {
    const parsed = parseComposeFile(`
services:
  api:
    image: myorg/api
    restart: unless-stopped
`);
    expect(parsed.services[0]?.restart).toBe("unless-stopped");
  });

  it("extracts the command override", () => {
    const parsed = parseComposeFile(`
services:
  worker:
    image: node:22
    command: node worker.js --concurrency 4
`);
    expect(parsed.services[0]?.command).toBe("node worker.js --concurrency 4");
  });

  it("extracts volumes list", () => {
    const parsed = parseComposeFile(`
services:
  db:
    image: postgres:16
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./init.sql:/docker-entrypoint-initdb.d/init.sql:ro
`);
    expect(parsed.services[0]?.volumes).toEqual([
      "pgdata:/var/lib/postgresql/data",
      "./init.sql:/docker-entrypoint-initdb.d/init.sql:ro",
    ]);
  });

  it("folds long-form `read_only: true` into a :ro bind (read-only intent survives)", () => {
    const parsed = parseComposeFile(`
services:
  app:
    image: nginx
    volumes:
      - type: bind
        source: /host/config
        target: /etc/nginx/conf.d
        read_only: true
      - type: volume
        source: cache
        target: /var/cache
`);
    // read_only must produce the ":ro" suffix downstream honors — dropping it
    // would create a writable mount despite the config declaring read-only.
    expect(parsed.services[0]?.volumes).toEqual([
      "/host/config:/etc/nginx/conf.d:ro",
      "cache:/var/cache",
    ]);
  });

  it("folds long-form `bind.selinux` and `volume.nocopy` into their mode suffix", () => {
    const parsed = parseComposeFile(`
services:
  app:
    image: nginx
    volumes:
      - type: bind
        source: /host/data
        target: /data
        bind:
          selinux: Z
      - type: volume
        source: cache
        target: /cache
        volume:
          nocopy: true
`);
    // Dropping these would collapse both to their bare "source:target" — the
    // MODE_SUFFIX regex downstream (volume-namespace.ts) already recognizes
    // z/Z/nocopy, same as :ro; the long form just never emitted them.
    expect(parsed.services[0]?.volumes).toEqual(["/host/data:/data:Z", "cache:/cache:nocopy"]);
  });

  it("throws on invalid YAML (callers wrap in try/catch)", () => {
    // parseComposeFile is expected to throw on syntax errors. The caller in
    // prepare.service.ts swallows the error and continues without services.
    expect(() => parseComposeFile(`this: is: not: valid: yaml`)).toThrow();
  });

  it("returns an empty services array when 'services' key is missing", () => {
    const parsed = parseComposeFile(`version: "3.9"\nnetworks:\n  default:\n`);
    expect(parsed.services).toEqual([]);
  });
});
